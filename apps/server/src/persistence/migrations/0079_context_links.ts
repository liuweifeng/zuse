import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0079ContextLinks = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE session_context_links (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK(kind IN ('merge_back','subagent_result')),
		source_session_id TEXT NOT NULL,
		target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		target_message_id TEXT NOT NULL,
		base_message_id TEXT,
		source_message_id TEXT,
		source_sequence INTEGER NOT NULL,
		context_text TEXT NOT NULL,
		after_turn_ordinal INTEGER NOT NULL,
		first_turn_id TEXT,
		invalidated_at INTEGER,
		origin_turn_id TEXT,
		origin_attempt_id TEXT,
		created_at INTEGER NOT NULL
	)`;
	yield* sql`CREATE INDEX session_context_links_target ON session_context_links(target_session_id,first_turn_id,created_at)`;
	yield* sql`CREATE INDEX session_context_links_source ON session_context_links(source_session_id,target_session_id,source_sequence)`;
});
