import { projectSessionInput } from "@zuse/domain/projectors/sql-input-projector";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { Migration0071SessionInputs } from "../../src/persistence/migrations/0071_session_inputs.ts";

const question = (itemId: string) =>
	JSON.stringify({
		_tag: "user_question",
		itemId,
		questions: [{ question: "Choose", options: ["A"] }],
	});

test("backfills paged legacy inputs and preserves terminal state on replay", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`PRAGMA foreign_keys = ON`;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT,
		kind TEXT, content_json TEXT, created_at TEXT, sequence INTEGER)`;
			yield* sql`CREATE TABLE events (sequence INTEGER PRIMARY KEY, stream_kind TEXT,
		stream_id TEXT, type TEXT, payload_json TEXT)`;
			yield* sql`INSERT INTO sessions (id) VALUES ('session')`;

			for (let index = 0; index < 503; index++) {
				yield* sql`INSERT INTO messages VALUES (${`message-${index}`}, 'session', NULL,
				'user_question', ${question(`question-${index}`)}, '2026-01-01T00:00:00.000Z', 1)`;
			}
			const answer = JSON.stringify({
				_tag: "user_question_answer",
				itemId: "question-0",
				answers: [{ questionIndex: 0, selected: [0] }],
			});
			yield* sql`INSERT INTO messages VALUES ('answer', 'session', NULL,
			'user_question_answer', ${answer}, '2026-01-01T00:00:01.000Z', 2)`;
			yield* sql`INSERT INTO events VALUES (3, 'session', 'session', 'QuestionResolved',
			${JSON.stringify({ itemId: "question-1", resolution: "cancelled", resolvedAt: 3 })})`;
			yield* sql`INSERT INTO events VALUES (4, 'session', 'session', 'PermissionRequested',
			${JSON.stringify({ requestId: "permission", turnId: "turn", payloadJson: "{}", requestedAt: 4 })})`;
			yield* sql`INSERT INTO events VALUES (5, 'session', 'session', 'PermissionExpired',
			${JSON.stringify({ requestId: "permission", expiredAt: 5 })})`;
			yield* sql`UPDATE messages SET sequence = NULL WHERE id = 'message-3'`;
			yield* sql`INSERT INTO messages VALUES ('timeout', 'session', NULL,
				'user_question_answer', ${JSON.stringify({ _tag: "user_question_answer", itemId: "question-2", answers: [], resolution: "timed-out" })},
				'2026-01-01T00:00:01.000Z', 2)`;
			yield* sql`INSERT INTO messages VALUES ('invalid', 'session', NULL,
				'user_question', '{invalid json', '2026-01-01T00:00:00.000Z', 0)`;
			yield* Migration0071SessionInputs;
			expect(yield* sql`SELECT count(*) AS total FROM session_inputs`).toEqual([
				{ total: 504 },
			]);
			expect(
				yield* sql`SELECT status, count(*) AS total FROM session_inputs GROUP BY status ORDER BY status`,
			).toEqual([
				{ status: "answered", total: 1 },
				{ status: "cancelled", total: 1 },
				{ status: "expired", total: 2 },
				{ status: "pending", total: 500 },
			]);
			yield* projectSessionInput(sql, {
				streamId: "session",
				sequence: 6,
				event: {
					_tag: "PermissionResolved",
					requestId: "permission",
					decision: "Deny",
					resolvedAt: 6,
				},
			});
			yield* Migration0071SessionInputs;
			expect(
				yield* sql`SELECT status FROM session_inputs WHERE request_id = 'permission'`,
			).toEqual([{ status: "answered" }]);
			const plan = yield* sql<{
				detail: string;
			}>`EXPLAIN QUERY PLAN SELECT request_json FROM session_inputs
			WHERE session_id = 'session' AND kind = 'question' AND status = 'pending'
			ORDER BY requested_sequence LIMIT 513`;
			expect(
				plan.some((row) => row.detail.includes("session_inputs_pending")),
			).toBe(true);
			yield* sql`DELETE FROM sessions WHERE id = 'session'`;
			expect(yield* sql`SELECT count(*) AS total FROM session_inputs`).toEqual([
				{ total: 0 },
			]);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
