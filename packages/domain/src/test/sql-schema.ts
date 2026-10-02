import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const createDomainTestSchema = Effect.fn("createDomainTestSchema")(
	function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
		CREATE TABLE app_state (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE chats (
			id TEXT PRIMARY KEY,
			project_id TEXT,
			worktree_id TEXT,
			title TEXT,
			title_provenance TEXT NOT NULL DEFAULT 'manual',
			active_session_id TEXT,
			origin_session_id TEXT,
			archived_at TEXT,
			archived_worktree_json TEXT,
			last_message_at TEXT,
			last_user_message_at TEXT,
			last_read_at TEXT,
			created_at TEXT,
			updated_at TEXT
		)
	`;
		yield* sql`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			title TEXT NOT NULL,
			title_provenance TEXT NOT NULL DEFAULT 'manual',
			provider_id TEXT NOT NULL,
			model TEXT NOT NULL,
			status TEXT NOT NULL,
			archived_at TEXT,
			active_provider_thread_id TEXT,
			provider_reservation_id TEXT,
			runtime_mode TEXT NOT NULL,
			agents_json TEXT,
			worktree_id TEXT,
			chat_id TEXT NOT NULL,
			forked_from_session_id TEXT,
			forked_from_message_id TEXT,
			permission_mode TEXT NOT NULL,
			tool_search INTEGER NOT NULL,
			queue_paused INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE session_provider_threads (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			native_thread_id TEXT NOT NULL,
			native_head_id TEXT,
			status TEXT NOT NULL,
			first_turn_ordinal INTEGER,
			last_turn_ordinal INTEGER,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;
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
			provider_turn_json TEXT,
			PRIMARY KEY (session_id, id),
			UNIQUE (session_id, turn_id, ordinal)
		)
	`;
		yield* sql`
		CREATE TABLE session_turns (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			status TEXT NOT NULL,
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
		CREATE TABLE queued_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			queue_order INTEGER NOT NULL,
			input_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			ready INTEGER NOT NULL DEFAULT 1
		)
	`;
		yield* sql`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			turn_id TEXT,
			role TEXT NOT NULL,
			kind TEXT NOT NULL,
			content_json TEXT NOT NULL,
			parent_item_id TEXT,
			created_at TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			checkpoint_revision INTEGER,
			checkpoint_final INTEGER
		)
	`;
		yield* sql`
		CREATE TABLE events (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT NOT NULL UNIQUE,
			stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL,
			stream_version INTEGER NOT NULL,
			type TEXT NOT NULL,
			occurred_at TEXT NOT NULL,
			actor TEXT,
			payload_json TEXT NOT NULL,
			correlation_id TEXT,
			causation_event_id TEXT,
			UNIQUE (stream_kind, stream_id, stream_version)
		)
	`;
		yield* sql`
		CREATE TABLE projector_cursors (
			projector_name TEXT PRIMARY KEY,
			last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
			updated_at TEXT NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE command_receipts (
			command_id TEXT PRIMARY KEY,
			stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL,
			stream_version INTEGER NOT NULL,
			event_ids_json TEXT NOT NULL,
			result_json TEXT,
			fingerprint TEXT,
			command_kind TEXT,
			schema_version INTEGER,
			storage_incarnation_id TEXT,
			created_at TEXT NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE projected_messages (
			message_id TEXT PRIMARY KEY,
			content_json TEXT NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE jobs (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			session_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			request_json TEXT NOT NULL,
			status TEXT NOT NULL,
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
	},
);
