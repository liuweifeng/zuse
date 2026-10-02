import { SessionEvent } from "@zuse/domain/core/events";
import { projectSessionAttempt } from "@zuse/domain/projectors/sql-attempt-projector";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0066AttemptHistory = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE IF NOT EXISTS session_attempts (
			session_id TEXT NOT NULL,
			id TEXT NOT NULL,
			turn_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL CHECK (ordinal > 0),
			reason TEXT NOT NULL CHECK (reason IN ('initial', 'retry', 'provider_recovery')),
			status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'failed', 'superseded')),
			started_at TEXT NOT NULL,
			completed_at TEXT,
			started_sequence INTEGER NOT NULL,
			updated_sequence INTEGER NOT NULL,
			PRIMARY KEY (session_id, id),
			UNIQUE (session_id, turn_id, ordinal)
		)
	`;
	// Page lifecycle events globally. Even large transcripts do not enter memory.
	let after = 0;
	while (true) {
		const rows = yield* sql<{
			sequence: number;
			stream_id: string;
			type: string;
			payload_json: string;
		}>`
			SELECT e.sequence, e.stream_id, e.type, e.payload_json FROM events e
			JOIN sessions s ON s.id = e.stream_id
			WHERE e.stream_kind = 'session' AND e.sequence > ${after}
				AND e.type IN ('TurnStarted', 'AttemptStarted', 'TurnSettled')
			ORDER BY e.sequence LIMIT 500
		`;
		if (rows.length === 0) break;
		for (const row of rows) {
			const payload = yield* Effect.try(() => JSON.parse(row.payload_json));
			const event = yield* Schema.decodeUnknownEffect(SessionEvent)({
				...payload,
				_tag: row.type,
			});
			yield* projectSessionAttempt(sql, {
				sequence: row.sequence,
				streamId: row.stream_id,
				event,
			});
			after = row.sequence;
		}
	}
});
