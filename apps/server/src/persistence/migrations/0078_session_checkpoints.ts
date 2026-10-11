import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0078SessionCheckpoints = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE session_turns_updated (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('starting','running','finalizing','completed','interrupted','failed','rolled_back')),
  phase TEXT, provider_thread_id TEXT, active_attempt_id TEXT NOT NULL, attempt_ordinal INTEGER NOT NULL,
  attempt_reason TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(session_id,ordinal)
 )`;
	yield* sql`INSERT INTO session_turns_updated SELECT * FROM session_turns`;
	yield* sql`DROP TABLE session_turns`;
	yield* sql`ALTER TABLE session_turns_updated RENAME TO session_turns`;
	yield* sql`CREATE INDEX idx_session_turns_session_status ON session_turns(session_id,status)`;
	yield* sql`CREATE INDEX idx_session_turns_status ON session_turns(status)`;
	yield* sql`CREATE TABLE session_checkpoints (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, scope_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('baseline','final')),
  cwd TEXT NOT NULL, project_id TEXT NOT NULL, worktree_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('capturing','ready','error','stale','unsupported')),
  commit_id TEXT, message_sequence INTEGER NOT NULL, outcome TEXT,
  error TEXT, created_at INTEGER NOT NULL, captured_at INTEGER,
  UNIQUE(session_id,turn_id,attempt_id,phase)
 )`;
	yield* sql`CREATE INDEX idx_session_checkpoints_session ON session_checkpoints(session_id,created_at)`;
	yield* sql`CREATE INDEX idx_session_checkpoints_pending ON session_checkpoints(status)`;
	yield* sql`CREATE TABLE session_checkpoint_previews(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,target_id TEXT NOT NULL,expected_id TEXT NOT NULL,cwd TEXT NOT NULL,created_at INTEGER NOT NULL)`;
	yield* sql`CREATE TABLE session_checkpoint_restores (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, worktree_id TEXT,
  cwd TEXT NOT NULL, target_id TEXT NOT NULL, expected_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','files_restored','completed','error','cancelled')),
  through_ordinal INTEGER NOT NULL, removed_message_ids_json TEXT NOT NULL,
  error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
 )`;
	yield* sql`CREATE UNIQUE INDEX idx_session_checkpoint_restore_owner ON session_checkpoint_restores(cwd) WHERE completed_at IS NULL`;
});
