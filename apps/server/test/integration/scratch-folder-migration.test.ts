import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Migration0087ScratchFolders } from "../../src/persistence/migrations/0087_scratch_folders.ts";
import { Migration0088ScratchFoldersRepair } from "../../src/persistence/migrations/0088_scratch_folders_repair.ts";
import {
	MigrationsLive,
	MigrationsThrough0086Live,
} from "../../src/persistence/migrations.ts";

it("preserves existing projects and defaults newly registered projects to ordinary folders", async () => {
	const rows = await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL)`;
			yield* sql`INSERT INTO projects VALUES ('existing', '/repos/existing')`;
			yield* Migration0087ScratchFolders;
			yield* sql`INSERT INTO projects (id, path) VALUES ('new', '/repos/new')`;
			yield* sql`INSERT INTO projects (id, path, kind) VALUES ('scratch', '/scratch/task', 'scratch')`;
			return yield* sql`SELECT id, path, kind FROM projects ORDER BY id`;
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
	expect(rows).toEqual([
		{ id: "existing", path: "/repos/existing", kind: "project" },
		{ id: "new", path: "/repos/new", kind: "project" },
		{ id: "scratch", path: "/scratch/task", kind: "scratch" },
	]);
});

it.each([
	"masters",
	"scratch_folders",
	null,
])("upgrades and restarts a populated database with slot 87 = %s", async (migrationName) => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-projectless-upgrade-"));
	const filename = join(directory, "db.sqlite");
	const runtime = (migrations: typeof MigrationsLive) => {
		const sqlite = sqliteLayer({ filename, disableWAL: true });
		return ManagedRuntime.make(
			Layer.merge(sqlite, migrations.pipe(Layer.provide(sqlite))),
		);
	};
	const previous = runtime(MigrationsThrough0086Live);
	try {
		await previous.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('existing','/repos/existing','Existing','2026-10-01','2026-10-01')`;
				yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('chat','existing','Retained','2026-10-01','2026-10-01')`;
				yield* sql`CREATE TABLE preview_data (id TEXT PRIMARY KEY)`;
				yield* sql`INSERT INTO preview_data VALUES ('preserved')`;
				if (migrationName === "scratch_folders") {
					yield* Migration0087ScratchFolders;
					yield* sql`UPDATE projects SET kind = 'scratch' WHERE id = 'existing'`;
				}
				if (migrationName !== null) {
					yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (87,${migrationName})`;
				}
			}),
		);
		await previous.dispose();
		if (migrationName === "masters") {
			await expect(
				Effect.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* Migration0088ScratchFoldersRepair;
								yield* sql`SELECT * FROM injected_missing_table`;
							}),
						);
					}).pipe(Effect.provide(sqliteLayer({ filename, disableWAL: true }))),
				),
			).rejects.toThrow();
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const columns = yield* sql<{
						name: string;
					}>`PRAGMA table_info(projects)`;
					expect(columns.some((column) => column.name === "kind")).toBe(false);
					expect(
						yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id=88`,
					).toEqual([]);
				}).pipe(Effect.provide(sqliteLayer({ filename, disableWAL: true }))),
			);
		}
		for (let restart = 0; restart < 2; restart++) {
			const upgraded = runtime(MigrationsLive);
			try {
				await upgraded.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						expect(yield* sql`SELECT id,path,kind FROM projects`).toEqual([
							{
								id: "existing",
								path: "/repos/existing",
								kind:
									migrationName === "scratch_folders" ? "scratch" : "project",
							},
						]);
						expect(yield* sql`SELECT id FROM chats`).toEqual([{ id: "chat" }]);
						expect(yield* sql`SELECT id FROM preview_data`).toEqual([
							{ id: "preserved" },
						]);
						expect(
							yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id=87`,
						).toEqual([{ name: migrationName ?? "scratch_folders" }]);
						expect(yield* sql`PRAGMA integrity_check`).toEqual([
							{ integrity_check: "ok" },
						]);
					}),
				);
			} finally {
				await upgraded.dispose();
			}
		}
	} finally {
		await previous.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
