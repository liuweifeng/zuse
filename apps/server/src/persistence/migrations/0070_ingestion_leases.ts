import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0070IngestionLeases = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE IF NOT EXISTS session_ingestion_leases (
		session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
		turn_id TEXT NOT NULL,
		attempt_id TEXT NOT NULL,
		provider_session_id TEXT NOT NULL,
		owner_id TEXT NOT NULL,
		heartbeat_at INTEGER NOT NULL,
		provider_activity_at INTEGER,
		expires_at INTEGER NOT NULL
	)`;
	yield* sql`CREATE INDEX IF NOT EXISTS session_ingestion_leases_expiry ON session_ingestion_leases(expires_at, session_id)`;
});
