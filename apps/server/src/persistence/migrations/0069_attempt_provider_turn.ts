import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Historical executions have no proven native turn identity; do not guess one. */
export const Migration0069AttemptProviderTurn = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql<{
		name: string;
	}>`PRAGMA table_info(session_attempts)`;
	if (!columns.some((column) => column.name === "provider_turn_json")) {
		yield* sql`ALTER TABLE session_attempts ADD COLUMN provider_turn_json TEXT`;
	}
});
