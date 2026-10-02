import { AgentItemId, SessionId } from "@zuse/contracts";
import { createSessionInputProjection } from "@zuse/domain/projectors/sql-input-projector";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { loadQuestionAuthority } from "../../src/conversation/core/question-authority.ts";

test("requires the recorded input owner and preserves original turn attribution", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY, archived_at TEXT, provider_reservation_id TEXT)`;
			yield* sql`CREATE TABLE session_turns (session_id TEXT, id TEXT, active_attempt_id TEXT, status TEXT, phase TEXT)`;
			yield* createSessionInputProjection(sql);
			yield* sql`INSERT INTO sessions VALUES ('session', NULL, 'provider')`;
			yield* sql`INSERT INTO session_turns VALUES ('session', 'turn', 'attempt', 'running', 'running')`;
			const owner = {
				providerSessionId: "provider",
				attempt: { turnId: "turn", attemptId: "attempt" },
			};
			yield* sql`INSERT INTO session_inputs (session_id, kind, request_id, status, request_json, owner_json, turn_id, updated_sequence)
			VALUES ('session', 'question', 'question', 'pending', '{}', ${JSON.stringify(owner)}, 'turn', 1)`;
			const load = loadQuestionAuthority(
				sql,
				SessionId.make("session"),
				AgentItemId.make("question"),
			);
			expect(yield* load).toEqual({ owner, turnId: "turn" });
			yield* sql`UPDATE session_turns SET phase = 'interrupt-requested'`;
			expect(yield* load).toBeNull();
			yield* sql`UPDATE session_turns SET phase = 'running', active_attempt_id = 'replacement'`;
			expect(yield* load).toBeNull();
			yield* sql`UPDATE session_turns SET active_attempt_id = 'attempt', status = 'completed'`;
			expect(yield* load).toBeNull();
			yield* sql`UPDATE session_turns SET status = 'running'`;
			yield* sql`UPDATE sessions SET provider_reservation_id = 'replacement'`;
			expect(yield* load).toBeNull();
			yield* sql`UPDATE sessions SET provider_reservation_id = 'provider', archived_at = 'archived'`;
			expect(yield* load).toBeNull();
			yield* sql`UPDATE sessions SET archived_at = NULL`;
			yield* sql`UPDATE session_inputs SET owner_json = NULL`;
			expect(yield* load).toBeNull();
			yield* sql`UPDATE session_inputs SET owner_json = '{invalid json'`;
			expect(yield* load).toBeNull();
			const sessionOwner = { providerSessionId: "provider" };
			yield* sql`UPDATE session_inputs SET owner_json = ${JSON.stringify(sessionOwner)}, turn_id = NULL`;
			expect(yield* load).toEqual({ owner: sessionOwner, turnId: null });
			yield* sql`UPDATE session_inputs SET status = 'expired'`;
			expect(yield* load).toBeNull();
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
