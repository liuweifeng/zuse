import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0077ForkConstructions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	// Staged before the destination exists so admission is fenced from its first event.
	yield* sql`CREATE TABLE session_fork_constructions (
		session_id TEXT PRIMARY KEY,
		payload_json TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		error TEXT,
		cancelled_at INTEGER,
		completed_at INTEGER
	)`;
	yield* sql`CREATE INDEX session_fork_constructions_pending ON session_fork_constructions(created_at) WHERE completed_at IS NULL`;
});
