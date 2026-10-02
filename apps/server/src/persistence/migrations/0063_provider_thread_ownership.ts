import { scopeProviderThreadId } from "@zuse/domain/agent-engine/ids";
import { ProviderThreadSnapshot } from "@zuse/domain/core/events";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Repair pre-release engine databases whose native handles were shared across sessions. */
export const Migration0063ProviderThreadOwnership = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const references = yield* sql<{
		readonly session_id: string;
		readonly thread_id: string;
	}>`
		SELECT session_id, id AS thread_id FROM session_provider_threads
		UNION SELECT id, active_provider_thread_id FROM sessions WHERE active_provider_thread_id IS NOT NULL
		UNION SELECT session_id, provider_thread_id FROM session_turns WHERE provider_thread_id IS NOT NULL
	`;
	const decodeThread = Schema.decodeUnknownEffect(
		Schema.fromJsonString(ProviderThreadSnapshot),
	);
	const retired = new Set<string>();
	for (const reference of references) {
		const id = scopeProviderThreadId(reference.session_id, reference.thread_id);
		if (id === reference.thread_id) continue;
		// Copy before relinking. One historical row can be referenced by multiple
		// sessions; deleting it inside this loop would discard the other owners.
		yield* sql`
			INSERT INTO session_provider_threads
				(id, session_id, provider, native_thread_id, native_head_id, status,
				 first_turn_ordinal, last_turn_ordinal, created_at, updated_at)
			SELECT ${id}, ${reference.session_id}, provider, native_thread_id, native_head_id,
				'not_loaded', first_turn_ordinal, last_turn_ordinal, created_at, updated_at
			FROM session_provider_threads WHERE id = ${reference.thread_id}
			ON CONFLICT(id) DO NOTHING
		`;
		// Prefer the owner's recorded native head over a shared projection that
		// may have been overwritten by a fork before this migration.
		const snapshots = yield* sql<{ readonly snapshot: string }>`
			SELECT json_extract(payload_json, '$.providerThread') AS snapshot
			FROM events WHERE stream_kind = 'session' AND stream_id = ${reference.session_id}
				AND type = 'ProviderThreadUpdated'
				AND json_extract(payload_json, '$.providerThread.id') = ${reference.thread_id}
			ORDER BY stream_version DESC LIMIT 1
		`;
		if (snapshots[0] !== undefined) {
			const thread = yield* decodeThread(snapshots[0].snapshot);
			yield* sql`
				INSERT INTO session_provider_threads
					(id, session_id, provider, native_thread_id, native_head_id, status,
					 first_turn_ordinal, last_turn_ordinal, created_at, updated_at)
				VALUES (${id}, ${reference.session_id}, ${thread.provider},
					${thread.nativeThreadId}, ${thread.nativeHeadId}, 'not_loaded',
					${thread.firstTurnOrdinal}, ${thread.lastTurnOrdinal},
					${new Date(thread.createdAt).toISOString()}, ${new Date(thread.updatedAt).toISOString()})
				ON CONFLICT(id) DO UPDATE SET
					provider = excluded.provider, native_thread_id = excluded.native_thread_id,
					native_head_id = excluded.native_head_id, status = excluded.status,
					first_turn_ordinal = excluded.first_turn_ordinal,
					last_turn_ordinal = excluded.last_turn_ordinal,
					created_at = excluded.created_at, updated_at = excluded.updated_at
				WHERE session_provider_threads.session_id = excluded.session_id
			`;
		}
		const owned = yield* sql`
			SELECT id FROM session_provider_threads
			WHERE id = ${id} AND session_id = ${reference.session_id}
		`;
		if (owned.length === 0) {
			return yield* Effect.fail(
				new Error(
					`Cannot recover provider thread ${reference.thread_id} for session ${reference.session_id}`,
				),
			);
		}

		yield* sql`
			UPDATE sessions SET active_provider_thread_id = ${id}
			WHERE id = ${reference.session_id} AND active_provider_thread_id = ${reference.thread_id}
		`;
		yield* sql`
			UPDATE session_turns SET provider_thread_id = ${id}
			WHERE session_id = ${reference.session_id} AND provider_thread_id = ${reference.thread_id}
		`;
		retired.add(reference.thread_id);
	}
	for (const id of retired) {
		yield* sql`DELETE FROM session_provider_threads WHERE id = ${id}`;
	}
});
