import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Native keep-awake policy must observe activity without scanning conversation history. */
export const Migration0076TurnActivityIndex = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE INDEX idx_session_turns_status ON session_turns(status)`;
});
