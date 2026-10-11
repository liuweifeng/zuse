import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Durable job ledger. Provider-facing work implied by committed session events
 * is inserted here inside the same transaction, then claimed, leased, retried,
 * and settled by the job worker.
 */
export const Migration0063Jobs = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE jobs (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			session_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			request_json TEXT NOT NULL,
			status TEXT NOT NULL CHECK (
				status IN ('pending', 'waiting', 'running', 'succeeded', 'failed', 'cancelled')
			),
			attempt_count INTEGER NOT NULL DEFAULT 0,
			available_at TEXT NOT NULL,
			lease_owner TEXT,
			lease_expires_at TEXT,
			causation_event_id TEXT,
			correlation_id TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		)
	`;
	yield* sql`
		CREATE INDEX idx_jobs_claim ON jobs (status, available_at, sequence)
	`;
	yield* sql`
		CREATE INDEX idx_jobs_session ON jobs (session_id, status)
	`;
});
