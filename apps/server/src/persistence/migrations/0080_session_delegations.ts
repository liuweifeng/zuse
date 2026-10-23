import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0080SessionDelegations = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	yield* sql`CREATE TABLE session_delegations (
  child_session_id TEXT PRIMARY KEY,
  child_turn_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  parent_turn_id TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  result_message_id TEXT,
  result_status TEXT,
  cancelled_at INTEGER,
  wake_turn_id TEXT,
  created_at INTEGER NOT NULL
 )`;
	yield* sql`CREATE INDEX session_delegations_parent ON session_delegations(parent_session_id,parent_turn_id,created_at)`;
	yield* sql`CREATE INDEX session_delegations_pending ON session_delegations(created_at,child_session_id) WHERE wake_turn_id IS NULL AND cancelled_at IS NULL`;
});
