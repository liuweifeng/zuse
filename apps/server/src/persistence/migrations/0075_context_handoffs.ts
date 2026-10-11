import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0075ContextHandoffs = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE session_context_handoffs (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		provider_id TEXT NOT NULL,
		context_text TEXT NOT NULL,
		first_turn_id TEXT,
		active INTEGER NOT NULL DEFAULT 1,
		created_at INTEGER NOT NULL
	)`;
	yield* sql`CREATE UNIQUE INDEX session_context_handoffs_active ON session_context_handoffs(session_id) WHERE active=1`;
});
