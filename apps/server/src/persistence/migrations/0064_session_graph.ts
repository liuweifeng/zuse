import { derive } from "@zuse/domain/agent-engine/ids";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Session graph: provider threads and turns as durable rows.
 *
 * Replaces the resume token columns on `sessions` (`cursor`,
 * `resume_strategy`, `provider_event_cursor`) with `session_provider_threads`,
 * and the active turn columns (`current_turn_id`, `current_turn_phase`) with
 * `session_turns`, which also records every turn's ordinal and attempt.
 * Existing rows are migrated: each resume token becomes the session's active
 * provider thread, and every `TurnStarted` event becomes a turn row whose
 * ordinal is its position in the session's event stream.
 */
export const Migration0064SessionGraph = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE session_provider_threads (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			native_thread_id TEXT NOT NULL,
			native_head_id TEXT,
			status TEXT NOT NULL CHECK (
				status IN ('not_loaded', 'idle', 'active', 'closed', 'error')
			),
			first_turn_ordinal INTEGER,
			last_turn_ordinal INTEGER,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE INDEX idx_session_provider_threads_session
			ON session_provider_threads (session_id)
	`;
	yield* sql`
		CREATE TABLE session_turns (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			status TEXT NOT NULL CHECK (
				status IN ('starting', 'running', 'completed', 'interrupted', 'failed')
			),
			phase TEXT,
			provider_thread_id TEXT,
			active_attempt_id TEXT NOT NULL,
			attempt_ordinal INTEGER NOT NULL,
			attempt_reason TEXT NOT NULL,
			requested_at TEXT NOT NULL,
			completed_at TEXT,
			UNIQUE (session_id, ordinal)
		)
	`;
	yield* sql`
		CREATE INDEX idx_session_turns_session_status
			ON session_turns (session_id, status)
	`;
	yield* sql`ALTER TABLE sessions ADD COLUMN active_provider_thread_id TEXT`;

	const legacyColumns = new Set(
		(yield* sql<{ readonly name: string }>`PRAGMA table_info(sessions)`).map(
			(column) => column.name,
		),
	);
	// Resume tokens become provider threads. The app id derivation must match
	// the domain's so replayed events upsert the same row.
	const resumable = !legacyColumns.has("cursor")
		? []
		: yield* sql<{
				readonly id: string;
				readonly provider_id: string;
				readonly cursor: string;
				readonly provider_event_cursor: string | null;
				readonly created_at: string;
				readonly updated_at: string;
				readonly status: string;
			}>`
		SELECT id, provider_id, cursor, created_at, updated_at, status,
			${legacyColumns.has("provider_event_cursor") ? sql.literal("provider_event_cursor") : sql.literal("NULL AS provider_event_cursor")}
		FROM sessions WHERE cursor IS NOT NULL AND cursor <> ''
	`;
	for (const row of resumable) {
		const id = derive.providerThread({
			sessionId: row.id,
			provider: row.provider_id as Parameters<
				typeof derive.providerThread
			>[0]["provider"],
			nativeThreadId: row.cursor,
		});
		yield* sql`
			INSERT OR IGNORE INTO session_provider_threads
				(id, session_id, provider, native_thread_id, native_head_id, status,
				 first_turn_ordinal, last_turn_ordinal, created_at, updated_at)
			VALUES
				(${id}, ${row.id}, ${row.provider_id}, ${row.cursor},
				 ${row.provider_event_cursor}, 'idle', NULL, NULL,
				 ${row.created_at}, ${row.updated_at})
		`;
		yield* sql`
			UPDATE sessions SET active_provider_thread_id = ${id} WHERE id = ${row.id}
		`;
	}

	// Every TurnStarted becomes a turn row; its ordinal is its position among
	// the session's TurnStarted events, matching the domain's replay rule.
	yield* sql`
		INSERT OR IGNORE INTO session_turns
			(id, session_id, ordinal, status, phase, provider_thread_id,
			 active_attempt_id, attempt_ordinal, attempt_reason, requested_at, completed_at)
		SELECT
			json_extract(e.payload_json, '$.turnId'),
			e.stream_id,
			ROW_NUMBER() OVER (PARTITION BY e.stream_id ORDER BY e.stream_version),
			'completed',
			NULL,
			NULL,
			'attempt:turn:' || replace(replace(json_extract(e.payload_json, '$.turnId'), '%', '%25'), ':', '%3A') || ':ordinal:1',
			1,
			'initial',
			e.occurred_at,
			e.occurred_at
		FROM events e
		WHERE e.stream_kind = 'session' AND e.type = 'TurnStarted'
			AND json_extract(e.payload_json, '$.turnId') IS NOT NULL
	`;
	// Settle statuses from the terminal event of each turn.
	yield* sql`
		UPDATE session_turns
		SET status = CASE (
				SELECT json_extract(s.payload_json, '$.outcome') FROM events s
				WHERE s.stream_kind = 'session' AND s.stream_id = session_turns.session_id
					AND s.type = 'TurnSettled'
					AND json_extract(s.payload_json, '$.turnId') = session_turns.id
				ORDER BY s.stream_version DESC LIMIT 1
			)
			WHEN 'completed' THEN 'completed'
			WHEN 'interrupted' THEN 'interrupted'
			WHEN 'error' THEN 'failed'
			ELSE 'completed'
		END,
		completed_at = (
			SELECT s.occurred_at FROM events s
			WHERE s.stream_kind = 'session' AND s.stream_id = session_turns.session_id
				AND s.type = 'TurnSettled'
				AND json_extract(s.payload_json, '$.turnId') = session_turns.id
			ORDER BY s.stream_version DESC LIMIT 1
		)
	`;
	// Turns that were still in flight keep their live status from the head
	// columns this migration retires, so recovery sees them as it did before.
	if (legacyColumns.has("current_turn_id"))
		yield* sql`
		UPDATE session_turns
		SET status = 'running',
			phase = COALESCE((
				SELECT current_turn_phase FROM sessions
				WHERE sessions.id = session_turns.session_id
			), 'running'),
			completed_at = NULL
		WHERE id IN (
			SELECT current_turn_id FROM sessions WHERE current_turn_id IS NOT NULL
		)
	`;

	// Databases created by older migration subsets may lack some of these
	// columns; drop whichever exist.
	const columns = yield* sql<{ readonly name: string }>`
		PRAGMA table_info(sessions)
	`;
	const present = new Set(columns.map((column) => column.name));
	for (const column of [
		"cursor",
		"resume_strategy",
		"provider_event_cursor",
		"current_turn_id",
		"current_turn_phase",
	]) {
		if (!present.has(column)) continue;
		yield* sql.unsafe(`ALTER TABLE sessions DROP COLUMN ${column}`);
	}
});
