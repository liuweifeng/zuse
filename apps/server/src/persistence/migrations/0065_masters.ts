import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0065Masters = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE IF NOT EXISTS masters (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state_json TEXT NOT NULL)`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_repositories (
		environment_id TEXT NOT NULL, folder_id TEXT NOT NULL,
		master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
		PRIMARY KEY (environment_id, folder_id)
	)`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_artifacts (
		master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
		artifact_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
		PRIMARY KEY (master_id, artifact_id, version)
	)`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_revisions (
		master_id TEXT NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL, state_json TEXT NOT NULL,
		PRIMARY KEY (master_id, revision)
	)`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_commands (
		command_id TEXT PRIMARY KEY, master_id TEXT NOT NULL,
		fingerprint TEXT NOT NULL, result_json TEXT,
		phase TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, input_json TEXT
	)`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_target_commands (
		command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT, master_id TEXT NOT NULL, folder_id TEXT NOT NULL
	)`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_transcripts (master_id TEXT NOT NULL, session_id TEXT NOT NULL, markdown TEXT NOT NULL, PRIMARY KEY(master_id, session_id))`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_snapshots (master_id TEXT NOT NULL, environment_id TEXT NOT NULL, folder_id TEXT NOT NULL, summaries_json TEXT NOT NULL, PRIMARY KEY(master_id, environment_id, folder_id))`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_transfers (master_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, destination TEXT NOT NULL, payload_json TEXT)`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_worker_origins (session_id TEXT PRIMARY KEY, master_id TEXT NOT NULL, home_environment_id TEXT NOT NULL, folder_id TEXT NOT NULL)`;
	yield* sql`CREATE TABLE IF NOT EXISTS master_interrupts (command_id TEXT PRIMARY KEY, master_id TEXT NOT NULL, environment_id TEXT NOT NULL, folder_id TEXT NOT NULL, session_id TEXT NOT NULL)`;
});
