import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0081ProviderContexts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE session_provider_contexts (
		provider_thread_id TEXT PRIMARY KEY REFERENCES session_provider_threads(id) ON DELETE CASCADE,
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		through_sequence INTEGER NOT NULL,
		pending_message_ids_json TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`;
	yield* sql`CREATE INDEX session_provider_contexts_session ON session_provider_contexts(session_id)`;
	yield* sql`ALTER TABLE session_context_handoffs ADD COLUMN resume_thread_id TEXT`;
	yield* sql`ALTER TABLE session_context_handoffs ADD COLUMN fallback_context_text TEXT`;
	yield* sql`ALTER TABLE session_context_handoffs ADD COLUMN fallback_at INTEGER`;
});
