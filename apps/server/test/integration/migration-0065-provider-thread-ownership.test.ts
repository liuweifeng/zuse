import { scopeProviderThreadId } from "@zuse/domain/agent-engine/ids";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { Migration0065ProviderThreadOwnership } from "../../src/persistence/migrations/0065_provider_thread_ownership.ts";

const setup = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE session_provider_threads (id TEXT PRIMARY KEY, session_id TEXT, provider TEXT, native_thread_id TEXT, native_head_id TEXT, status TEXT, first_turn_ordinal INTEGER, last_turn_ordinal INTEGER, created_at TEXT, updated_at TEXT)`;
	yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY, active_provider_thread_id TEXT)`;
	yield* sql`CREATE TABLE session_turns (session_id TEXT, provider_thread_id TEXT)`;
	yield* sql`CREATE TABLE events (stream_kind TEXT, stream_id TEXT, stream_version INTEGER, type TEXT, payload_json TEXT)`;
	return sql;
});
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

describe("migration 0065 provider thread ownership", () => {
	it.each([
		true,
		false,
	])("recovers each owner's event snapshot (shared row exists: %s)", async (sharedRowExists) => {
		await run(
			Effect.gen(function* () {
				const sql = yield* setup;
				if (sharedRowExists)
					yield* sql`INSERT INTO session_provider_threads VALUES ('legacy', 'fork', 'codex', 'native', 'overwritten', 'active', 1, 9, 'old', 'old')`;
				for (const session of ["parent", "fork"]) {
					yield* sql`INSERT INTO sessions VALUES (${session}, 'legacy')`;
					yield* sql`INSERT INTO session_turns VALUES (${session}, 'legacy')`;
					const payload = JSON.stringify({
						providerThread: {
							id: "legacy",
							provider: "codex",
							nativeThreadId: "native",
							nativeHeadId: `${session}-head`,
							status: "idle",
							firstTurnOrdinal: 1,
							lastTurnOrdinal: 2,
							createdAt: 0,
							updatedAt: 1000,
						},
					});
					yield* sql`INSERT INTO events VALUES ('session', ${session}, 1, 'ProviderThreadUpdated', ${payload})`;
				}
				yield* Migration0065ProviderThreadOwnership;
				const rows =
					yield* sql`SELECT id, session_id, native_head_id, status, last_turn_ordinal FROM session_provider_threads ORDER BY session_id`;
				expect(rows).toEqual(
					["fork", "parent"].map((session) => ({
						id: scopeProviderThreadId(session, "legacy"),
						session_id: session,
						native_head_id: `${session}-head`,
						status: "not_loaded",
						last_turn_ordinal: 2,
					})),
				);
				const references =
					yield* sql`SELECT s.id, s.active_provider_thread_id, t.provider_thread_id FROM sessions s JOIN session_turns t ON t.session_id = s.id ORDER BY s.id`;
				expect(references).toEqual(
					["fork", "parent"].map((session) => ({
						id: session,
						active_provider_thread_id: scopeProviderThreadId(session, "legacy"),
						provider_thread_id: scopeProviderThreadId(session, "legacy"),
					})),
				);
				yield* Migration0065ProviderThreadOwnership;
				expect(
					yield* sql`SELECT id, session_id, native_head_id, status, last_turn_ordinal FROM session_provider_threads ORDER BY session_id`,
				).toEqual(rows);
			}),
		);
	});
	it("rejects dangling references without recoverable event data", async () => {
		await expect(
			run(
				Effect.gen(function* () {
					const sql = yield* setup;
					yield* sql`INSERT INTO sessions VALUES ('parent', 'missing')`;
					yield* Migration0065ProviderThreadOwnership;
				}),
			),
		).rejects.toThrow("Cannot recover provider thread missing");
	});
});
