import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import {
	MigrationsLive,
	MigrationsThrough0062Live,
	MigrationsThrough0073Live,
} from "../../src/persistence/migrations.ts";

const runtime = (filename: string, migrations = MigrationsLive) => {
	const sqlite = sqliteLayer({ filename, disableWAL: true });
	return ManagedRuntime.make(
		Layer.merge(sqlite, migrations.pipe(Layer.provide(sqlite))),
	);
};

it("upgrades main while preserving harness executions and encrypted model records", async () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-main-upgrade-"));
	const filename = join(directory, "db.sqlite");
	const previous = runtime(filename, MigrationsThrough0062Live);
	try {
		await previous.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO harness_executions VALUES ('root', 7, '{"state":"waiting"}', '2026-10-01')`;
				yield* sql`INSERT INTO model_connection_secrets VALUES ('local', 'connection', 'encrypted', 42)`;
			}),
		);
		await previous.dispose();
		const upgraded = runtime(filename);
		try {
			await upgraded.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(yield* sql`SELECT * FROM harness_executions`).toEqual([
						{
							root_id: "root",
							revision: 7,
							state_json: '{"state":"waiting"}',
							updated_at: "2026-10-01",
						},
					]);
					expect(
						yield* sql`SELECT envelope FROM model_connection_secrets`,
					).toEqual([{ envelope: "encrypted" }]);
					expect(
						yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id >= 61 ORDER BY migration_id`,
					).toHaveLength(16);
					expect(yield* sql`SELECT * FROM jobs`).toEqual([]);
					const plan = yield* sql<{
						detail: string;
					}>`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM session_turns WHERE status IN ('starting', 'running')`;
					expect(
						plan.some((row) => row.detail.includes("idx_session_turns_status")),
					).toBe(true);
				}),
			);
		} finally {
			await upgraded.dispose();
		}
	} finally {
		await previous.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each([
	false,
	true,
])("repairs the unpublished engine ledger atomically (unknown migration: %s)", async (unknown) => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-engine-upgrade-"));
	const filename = join(directory, "db.sqlite");
	const previous = runtime(filename, MigrationsThrough0073Live);
	try {
		await previous.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				// Reproduce the pre-rebase schema: engine tables existed without main's two tables.
				yield* sql`DROP TABLE harness_executions`;
				yield* sql`DROP TABLE model_connection_secrets`;
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (61,62)`;
				const rows = yield* sql<{
					migration_id: number;
				}>`SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= 63 ORDER BY migration_id`;
				for (const row of rows)
					yield* sql`UPDATE effect_sql_migrations SET migration_id = ${row.migration_id - 2} WHERE migration_id = ${row.migration_id}`;
				yield* sql`INSERT INTO jobs (id, session_id, kind, request_json, status, available_at, created_at, updated_at) VALUES ('retained', 'session', 'stop-session', '{}', 'pending', '2026-10-01', '2026-10-01', '2026-10-01')`;
				if (unknown)
					yield* sql`UPDATE effect_sql_migrations SET name = 'unknown' WHERE migration_id = 71`;
			}),
		);
		await previous.dispose();
		const upgraded = runtime(filename);
		try {
			if (unknown) {
				await expect(upgraded.runPromise(Effect.void)).rejects.toThrow(
					"Unrecognized migration history",
				);
			} else {
				await upgraded.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						expect(yield* sql`SELECT id FROM jobs`).toEqual([
							{ id: "retained" },
						]);
						expect(
							yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE name = 'jobs'`,
						).toEqual([{ migration_id: 63 }]);
						expect(yield* sql`SELECT * FROM harness_executions`).toEqual([]);
						expect(yield* sql`SELECT * FROM model_connection_secrets`).toEqual(
							[],
						);
					}),
				);
			}
		} finally {
			await upgraded.dispose();
		}
		if (unknown) {
			const raw = ManagedRuntime.make(
				sqliteLayer({ filename, disableWAL: true }),
			);
			try {
				await raw.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						expect(
							yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE name = 'jobs'`,
						).toEqual([{ migration_id: 61 }]);
						expect(
							yield* sql`SELECT name FROM sqlite_master WHERE name IN ('harness_executions','model_connection_secrets')`,
						).toEqual([]);
						expect(yield* sql`SELECT id FROM jobs`).toEqual([
							{ id: "retained" },
						]);
					}),
				);
			} finally {
				await raw.dispose();
			}
		}
	} finally {
		await previous.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
