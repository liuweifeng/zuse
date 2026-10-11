import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { Migration0072InputOwnership } from "../../src/persistence/migrations/0072_input_ownership.ts";

test("upgrades original input attribution without inferring legacy callback ownership", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY, provider_reservation_id TEXT)`;
			yield* sql`INSERT INTO sessions VALUES ('session', 'current-provider')`;
			yield* sql`CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT,
			kind TEXT, content_json TEXT, created_at TEXT, sequence INTEGER)`;
			yield* sql`CREATE TABLE events (sequence INTEGER PRIMARY KEY, stream_kind TEXT, stream_id TEXT, type TEXT, payload_json TEXT)`;
			yield* sql`CREATE TABLE session_inputs (session_id TEXT, kind TEXT, request_id TEXT, status TEXT,
			request_json TEXT, requested_at TEXT, requested_sequence INTEGER, updated_sequence INTEGER,
			PRIMARY KEY(session_id, kind, request_id))`;
			const owner = {
				providerSessionId: "original-provider",
				attempt: { turnId: "original-turn", attemptId: "original-attempt" },
			};
			for (const [sequence, id] of [
				[1, "legacy"],
				[2, "owned"],
			] as const) {
				const content = JSON.stringify({
					_tag: "user_question",
					itemId: id,
					questions: [{ question: "Continue?", options: ["Yes"] }],
				});
				yield* sql`INSERT INTO messages VALUES (${id}, 'session', 'original-turn', 'user_question', ${content}, '2026-01-01T00:00:00.000Z', ${sequence})`;
				if (id === "owned")
					yield* sql`INSERT INTO events VALUES (${sequence}, 'session', 'session', 'MessagePersisted', ${JSON.stringify(
						{
							messageId: id,
							turnId: "original-turn",
							role: "assistant",
							kind: "user_question",
							contentJson: content,
							parentItemId: null,
							createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
							inputOwner: owner,
						},
					)})`;
			}
			yield* Migration0072InputOwnership;
			const read = sql`SELECT request_id, turn_id, owner_json FROM session_inputs ORDER BY request_id`;
			const expected = [
				{ request_id: "legacy", turn_id: "original-turn", owner_json: null },
				{
					request_id: "owned",
					turn_id: "original-turn",
					owner_json: JSON.stringify(owner),
				},
			];
			expect(yield* read).toEqual(expected);
			yield* Migration0072InputOwnership;
			expect(yield* read).toEqual(expected);
			yield* sql`DELETE FROM session_inputs`;
			yield* Migration0072InputOwnership;
			expect(yield* read).toEqual(expected);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
