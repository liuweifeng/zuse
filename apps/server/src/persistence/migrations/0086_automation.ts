import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0086Automation = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE IF NOT EXISTS scheduled_tasks (
		id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		client_request_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
		schedule_json TEXT NOT NULL, actor_json TEXT, enabled INTEGER NOT NULL DEFAULT 1,
		next_run_at INTEGER, last_run_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER,
		UNIQUE(session_id, client_request_id)
	)`;
	yield* sql`CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at)`;
	yield* sql`CREATE TABLE IF NOT EXISTS scheduled_task_deliveries (
		task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
		event_id TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL,
		created_at INTEGER NOT NULL, delivered_at INTEGER, retry_after INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY(task_id, event_id)
	)`;
	yield* sql`CREATE TABLE IF NOT EXISTS secret_requests (
		id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		client_request_id TEXT NOT NULL, label TEXT NOT NULL, reason TEXT NOT NULL,
		environment_variable TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
		created_at INTEGER NOT NULL, UNIQUE(session_id, client_request_id)
	)`;
});
