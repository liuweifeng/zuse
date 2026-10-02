import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { scopeProviderThreadId } from "../agent-engine/ids.js";

import type { ProviderThreadSnapshot } from "../core/events.js";
import { CompleteSessionCreatedEvent } from "../core/session-fields.js";
import { attemptIdFor, providerThreadIdFor } from "../core/state.js";
import type { StoredEvent } from "../engine/dispatch.js";
import type { ProjectorDefinition } from "../engine/projector-runner.js";
import {
	updateChatLastMessage,
	updateChatLastUserMessage,
} from "./chat-last-message-projection.js";

export class SessionProjectionDecodeError extends Schema.TaggedErrorClass<SessionProjectionDecodeError>()(
	"SessionProjectionDecodeError",
	{
		eventId: Schema.String,
		reason: Schema.String,
	},
) {}

export type SqlSessionProjectorError = SqlError | SessionProjectionDecodeError;

const decodeCreated = Schema.decodeUnknownEffect(CompleteSessionCreatedEvent);

/** Turn statuses that make a turn the session's active turn. */
export const ACTIVE_SESSION_TURN_STATUSES = ["starting", "running"] as const;

/** Keep the denormalized chat selection pointed at a live sibling session. */
const replaceUnavailableActiveSession = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	updatedAt: string,
) =>
	sql`
		UPDATE chats
		SET active_session_id = (
				SELECT replacement.id
				FROM sessions AS replacement
				WHERE replacement.chat_id = chats.id
					AND replacement.id <> ${sessionId}
					AND replacement.archived_at IS NULL
				ORDER BY replacement.updated_at DESC, replacement.id ASC
				LIMIT 1
			),
			updated_at = ${updatedAt}
		WHERE active_session_id = ${sessionId}
	`;

export const makeSqlSessionProjector = (
	sql: SqlClient.SqlClient,
): ProjectorDefinition<StoredEvent, SqlSessionProjectorError> => {
	const iso = (millis: number) => new Date(millis).toISOString();

	const upsertProviderThread = (
		sessionId: string,
		thread: ProviderThreadSnapshot,
	) =>
		sql`
			INSERT INTO session_provider_threads
				(id, session_id, provider, native_thread_id, native_head_id, status,
				 first_turn_ordinal, last_turn_ordinal, created_at, updated_at)
			VALUES
				(${scopeProviderThreadId(sessionId, thread.id)}, ${sessionId}, ${thread.provider}, ${thread.nativeThreadId},
				 ${thread.nativeHeadId}, ${thread.status}, ${thread.firstTurnOrdinal},
				 ${thread.lastTurnOrdinal}, ${iso(thread.createdAt)}, ${iso(thread.updatedAt)})
			ON CONFLICT(id) DO UPDATE SET
				native_thread_id = excluded.native_thread_id,
				native_head_id = excluded.native_head_id,
				status = excluded.status,
				first_turn_ordinal = COALESCE(session_provider_threads.first_turn_ordinal, excluded.first_turn_ordinal),
				last_turn_ordinal = excluded.last_turn_ordinal,
				updated_at = excluded.updated_at
			WHERE session_provider_threads.session_id = excluded.session_id
		`;

	const setActiveProviderThread = (
		sessionId: string,
		providerThreadId: string | null,
		updatedAt: string,
	) =>
		sql`
			UPDATE sessions
			SET active_provider_thread_id = ${providerThreadId === null ? null : scopeProviderThreadId(sessionId, providerThreadId)}, updated_at = ${updatedAt}
			WHERE id = ${sessionId}
		`;

	/** A provider or worktree change retires the active provider thread. */
	const retireActiveProviderThread = (sessionId: string, updatedAt: string) =>
		Effect.gen(function* () {
			yield* sql`
				UPDATE session_provider_threads
				SET status = 'closed', updated_at = ${updatedAt}
				WHERE id = (
					SELECT active_provider_thread_id FROM sessions WHERE id = ${sessionId}
				)
			`;
			yield* setActiveProviderThread(sessionId, null, updatedAt);
		});

	/** Legacy resume tokens bind a provider thread keyed by the session's provider. */
	const bindLegacyResume = (
		sessionId: string,
		nativeThreadId: string,
		nativeHeadId: string | null | undefined,
		at: number,
	) =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				readonly provider_id: string;
				readonly turn_ordinal: number | null;
				readonly native_head_id: string | null;
			}>`
				SELECT s.provider_id,
					(SELECT MAX(ordinal) FROM session_turns t
						WHERE t.session_id = s.id
							AND t.status IN ${sql.in([...ACTIVE_SESSION_TURN_STATUSES])}) AS turn_ordinal,
					(SELECT native_head_id FROM session_provider_threads p
						WHERE p.id = s.active_provider_thread_id) AS native_head_id
				FROM sessions s WHERE s.id = ${sessionId} LIMIT 1
			`;
			const row = rows[0];
			if (row === undefined) return;
			const id = providerThreadIdFor(
				sessionId,
				row.provider_id,
				nativeThreadId,
			);
			yield* upsertProviderThread(sessionId, {
				id,
				provider: row.provider_id,
				nativeThreadId,
				nativeHeadId:
					nativeHeadId === undefined ? row.native_head_id : nativeHeadId,
				status: row.turn_ordinal === null ? "idle" : "active",
				firstTurnOrdinal: row.turn_ordinal,
				lastTurnOrdinal: row.turn_ordinal,
				createdAt: at,
				updatedAt: at,
			});
			yield* setActiveProviderThread(sessionId, id, iso(at));
		});

	return {
		name: "session-read-model",
		sequenceOf: (record) => record.sequence,
		apply: Effect.fn("SqlSessionProjector.apply")(function* (
			record: StoredEvent,
		) {
			const event = record.event;
			switch (event._tag) {
				case "SessionCreated": {
					const created = yield* decodeCreated(event).pipe(
						Effect.mapError(
							(cause) =>
								new SessionProjectionDecodeError({
									eventId: record.eventId,
									reason: String(cause),
								}),
						),
					);
					const createdAt = iso(created.createdAt);
					yield* sql`
						INSERT OR IGNORE INTO sessions
							(id, project_id, title, title_provenance, provider_id, model, status,
							 archived_at, runtime_mode, agents_json, worktree_id, chat_id,
							 forked_from_session_id, forked_from_message_id, permission_mode,
							 tool_search, queue_paused, active_provider_thread_id,
							 created_at, updated_at)
						VALUES
							(${created.sessionId}, ${created.projectId}, ${created.title}, ${created.titleProvenance ?? "manual"},
							 ${created.providerId}, ${created.model}, ${created.status}, NULL,
							 ${created.runtimeMode}, ${created.agentsJson}, ${created.worktreeId},
							 ${created.chatId}, ${created.forkedFromSessionId}, ${created.forkedFromMessageId},
							 ${created.permissionMode}, ${created.toolSearch ? 1 : 0},
							 ${created.queuePaused ? 1 : 0}, NULL, ${createdAt}, ${createdAt})
					`;
					yield* sql`
						UPDATE chats
						SET active_session_id = ${created.sessionId}, updated_at = ${createdAt}
						WHERE id = ${created.chatId}
					`;
					if (created.cursor !== undefined && created.cursor !== null) {
						yield* bindLegacyResume(
							created.sessionId,
							created.cursor,
							null,
							created.createdAt,
						);
					}
					return;
				}
				case "SessionTitleSet": {
					const updatedAt = iso(event.updatedAt);
					yield* sql`
						UPDATE sessions
						SET title = ${event.title},
							title_provenance = ${event.titleProvenance ?? "manual"},
							updated_at = ${updatedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "SessionModelSet": {
					const updatedAt = iso(event.updatedAt);
					yield* sql`
						UPDATE sessions SET model = ${event.model}, provider_reservation_id = NULL, updated_at = ${updatedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "SessionProviderSet": {
					const updatedAt = iso(event.updatedAt);
					yield* retireActiveProviderThread(record.streamId, updatedAt);
					yield* sql`
						UPDATE sessions
						SET provider_id = ${event.providerId}, model = ${event.model}, provider_reservation_id = NULL,
							updated_at = ${updatedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "SessionRuntimeModeSet": {
					const updatedAt = iso(event.updatedAt);
					yield* sql`
						UPDATE sessions
						SET runtime_mode = ${event.runtimeMode}, updated_at = ${updatedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "SessionPermissionModeSet": {
					const updatedAt = iso(event.updatedAt);
					yield* sql`
						UPDATE sessions
						SET permission_mode = ${event.permissionMode}, updated_at = ${updatedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "SessionWorktreeSet": {
					const updatedAt = iso(event.updatedAt);
					const rows = yield* sql<{ readonly worktree_id: string | null }>`
						SELECT worktree_id FROM sessions WHERE id = ${record.streamId} LIMIT 1
					`;
					if (
						rows[0] !== undefined &&
						rows[0].worktree_id !== event.worktreeId
					) {
						yield* retireActiveProviderThread(record.streamId, updatedAt);
					}
					yield* sql`
						UPDATE sessions
						SET provider_reservation_id = CASE WHEN worktree_id IS ${event.worktreeId} THEN provider_reservation_id ELSE NULL END,
						worktree_id = ${event.worktreeId}, updated_at = ${updatedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "SessionStatusSet": {
					const updatedAt = iso(event.updatedAt);
					yield* sql`
						UPDATE sessions SET status = ${event.status}, updated_at = ${updatedAt}
						WHERE id = ${record.streamId}
					`;
					if (event.status === "running") {
						yield* sql`
							UPDATE session_turns SET status = 'running'
							WHERE session_id = ${record.streamId} AND status = 'starting'
						`;
					}
					return;
				}
				case "SessionQueuePausedSet": {
					const updatedAt = iso(event.updatedAt);
					yield* sql`
						UPDATE sessions
						SET queue_paused = ${event.paused ? 1 : 0}, updated_at = ${updatedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "QueuedTurnEnqueued": {
					const createdAt = iso(event.createdAt);
					yield* sql`
						INSERT INTO queued_messages
							(id, session_id, queue_order, input_json, created_at, updated_at, ready)
						VALUES
							(${event.queueId}, ${record.streamId}, ${event.position},
							 ${event.inputJson}, ${createdAt}, ${createdAt}, ${event.ready ? 1 : 0})
						ON CONFLICT(id) DO NOTHING
					`;
					yield* updateChatLastUserMessage(
						sql,
						record.streamId,
						event.createdAt,
					);
					return;
				}
				case "QueuedTurnUpdated": {
					const updatedAt = iso(event.updatedAt);
					yield* sql`
						UPDATE queued_messages
						SET input_json = ${event.inputJson}, updated_at = ${updatedAt},
							ready = ${event.ready ? 1 : 0}
						WHERE id = ${event.queueId} AND session_id = ${record.streamId}
					`;
					return;
				}
				case "QueuedTurnRemoved":
				case "QueuedTurnClaimed":
					yield* sql`
						DELETE FROM queued_messages
						WHERE id = ${event.queueId} AND session_id = ${record.streamId}
					`;
					return;
				case "QueuedTurnsReordered": {
					const updatedAt = iso(event.reorderedAt);
					for (const [position, queueId] of event.queueIds.entries()) {
						yield* sql`
							UPDATE queued_messages
							SET queue_order = ${position}, updated_at = ${updatedAt}
							WHERE id = ${queueId} AND session_id = ${record.streamId}
						`;
					}
					return;
				}
				case "SessionResumeSet": {
					if (event.cursor === null) return;
					yield* bindLegacyResume(
						record.streamId,
						event.cursor,
						event.providerEventCursor,
						event.updatedAt,
					);
					return;
				}
				case "ProviderThreadUpdated":
					yield* upsertProviderThread(record.streamId, event.providerThread);
					return;
				case "ActiveProviderThreadSet":
					yield* setActiveProviderThread(
						record.streamId,
						event.providerThreadId,
						iso(event.updatedAt),
					);
					return;
				case "SessionArchived": {
					const archivedAt = iso(event.archivedAt);
					yield* sql`
						UPDATE sessions
						SET archived_at = ${archivedAt}, provider_reservation_id = NULL, updated_at = ${archivedAt}
						WHERE id = ${record.streamId}
					`;
					yield* replaceUnavailableActiveSession(
						sql,
						record.streamId,
						archivedAt,
					);
					return;
				}
				case "SessionUnarchived": {
					const unarchivedAt = iso(event.unarchivedAt);
					yield* sql`
						UPDATE sessions SET archived_at = NULL, updated_at = ${unarchivedAt}
						WHERE id = ${record.streamId}
					`;
					yield* sql`
					UPDATE chats
					SET active_session_id = ${record.streamId}, updated_at = ${unarchivedAt}
					WHERE active_session_id IS NULL
						AND id = (
							SELECT chat_id FROM sessions WHERE id = ${record.streamId}
						)
				`;
					return;
				}
				case "SessionDeleted":
					yield* replaceUnavailableActiveSession(
						sql,
						record.streamId,
						iso(event.deletedAt),
					);
					yield* sql`DELETE FROM session_turns WHERE session_id = ${record.streamId}`;
					yield* sql`DELETE FROM session_provider_threads WHERE session_id = ${record.streamId}`;
					yield* sql`DELETE FROM sessions WHERE id = ${record.streamId}`;
					return;
				case "TurnStarted": {
					const startedAt = iso(event.startedAt);
					const ordinalRows = yield* sql<{ readonly next: number }>`
						SELECT COALESCE(MAX(ordinal), 0) + 1 AS next
						FROM session_turns WHERE session_id = ${record.streamId}
					`;
					const ordinal = event.ordinal ?? ordinalRows[0]?.next ?? 1;
					const attemptId = event.attemptId ?? attemptIdFor(event.turnId, 1);
					const providerThreadId =
						event.providerThreadId === undefined
							? ((yield* sql<{ readonly id: string | null }>`
									SELECT active_provider_thread_id AS id FROM sessions
									WHERE id = ${record.streamId} LIMIT 1
								`)[0]?.id ?? null)
							: event.providerThreadId === null
								? null
								: scopeProviderThreadId(
										record.streamId,
										event.providerThreadId,
									);
					yield* sql`
						INSERT INTO session_turns
							(id, session_id, ordinal, status, phase, provider_thread_id,
							 active_attempt_id, attempt_ordinal, attempt_reason,
							 requested_at, completed_at)
						VALUES
							(${event.turnId}, ${record.streamId}, ${ordinal}, 'starting', 'running',
							 ${providerThreadId}, ${attemptId}, 1, 'initial', ${startedAt}, NULL)
						ON CONFLICT(id) DO NOTHING
					`;
					if (providerThreadId !== null) {
						yield* sql`
							UPDATE session_provider_threads
							SET status = 'active',
								first_turn_ordinal = COALESCE(first_turn_ordinal, ${ordinal}),
								last_turn_ordinal = ${ordinal},
								updated_at = ${startedAt}
							WHERE id = ${providerThreadId} AND session_id = ${record.streamId}
						`;
					}
					yield* sql`
						UPDATE sessions SET status = 'running', updated_at = ${startedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "AttemptStarted": {
					const startedAt = iso(event.startedAt);
					yield* sql`
						UPDATE session_turns
						SET status = 'starting', phase = 'running',
							active_attempt_id = ${event.attemptId},
							attempt_ordinal = ${event.ordinal},
							attempt_reason = ${event.reason}
						WHERE id = ${event.turnId} AND session_id = ${record.streamId}
					`;
					yield* sql`
						UPDATE sessions SET updated_at = ${startedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "TurnInterruptRequested": {
					const requestedAt = iso(event.requestedAt);
					yield* sql`
						UPDATE session_turns SET phase = 'interrupt-requested'
						WHERE id = ${event.turnId} AND session_id = ${record.streamId}
							AND status IN ${sql.in([...ACTIVE_SESSION_TURN_STATUSES])}
					`;
					yield* sql`
						UPDATE sessions SET updated_at = ${requestedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "TurnInterruptAcknowledged": {
					const acknowledgedAt = iso(event.acknowledgedAt);
					yield* sql`
						UPDATE session_turns SET phase = 'interrupt-acknowledged'
						WHERE id = ${event.turnId} AND session_id = ${record.streamId}
							AND status IN ${sql.in([...ACTIVE_SESSION_TURN_STATUSES])}
					`;
					yield* sql`
						UPDATE sessions SET updated_at = ${acknowledgedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "TurnInterruptFailed": {
					const failedAt = iso(event.failedAt);
					yield* sql`
						UPDATE session_turns SET phase = 'running'
						WHERE id = ${event.turnId} AND session_id = ${record.streamId}
							AND status IN ${sql.in([...ACTIVE_SESSION_TURN_STATUSES])}
					`;
					yield* sql`
						UPDATE sessions SET updated_at = ${failedAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "TurnSettled": {
					const settledAt = iso(event.settledAt);
					const status =
						event.outcome === "completed"
							? "completed"
							: event.outcome === "interrupted"
								? "interrupted"
								: "failed";
					yield* sql`
						UPDATE session_turns
						SET status = ${status}, phase = NULL, completed_at = ${settledAt}
						WHERE id = ${event.turnId} AND session_id = ${record.streamId}
					`;
					yield* sql`
						UPDATE session_provider_threads
						SET status = 'idle', updated_at = ${settledAt}
						WHERE id = (
							SELECT active_provider_thread_id FROM sessions WHERE id = ${record.streamId}
						) AND status = 'active'
					`;
					yield* sql`
						UPDATE sessions SET status = 'idle', updated_at = ${settledAt}
						WHERE id = ${record.streamId}
					`;
					return;
				}
				case "MessagePersisted": {
					const createdAt = iso(event.createdAt);
					yield* sql`
						INSERT INTO messages
							(id, session_id, turn_id, role, kind, content_json, parent_item_id,
							 created_at, sequence, checkpoint_revision, checkpoint_final)
						VALUES
							(${event.messageId}, ${record.streamId}, ${event.turnId}, ${event.role},
							 ${event.kind}, ${event.contentJson}, ${event.parentItemId},
							 ${createdAt}, ${record.sequence}, ${event.checkpointRevision ?? null},
							 ${event.checkpointFinal === undefined ? null : event.checkpointFinal ? 1 : 0})
						ON CONFLICT(id) DO UPDATE SET
							turn_id = excluded.turn_id,
							role = excluded.role,
							kind = excluded.kind,
							content_json = excluded.content_json,
							parent_item_id = excluded.parent_item_id,
							checkpoint_revision = excluded.checkpoint_revision,
							checkpoint_final = excluded.checkpoint_final
						WHERE messages.checkpoint_final IS NOT 1
							AND ((excluded.checkpoint_revision IS NULL
									AND messages.checkpoint_revision IS NULL)
								OR (excluded.checkpoint_revision IS NOT NULL
									AND (messages.checkpoint_revision IS NULL
										OR excluded.checkpoint_revision > messages.checkpoint_revision)))
					`;
					yield* sql`
						UPDATE sessions SET updated_at = ${createdAt}
						WHERE id = ${record.streamId}
					`;
					yield* updateChatLastMessage(
						sql,
						{ _tag: "Session", sessionId: record.streamId },
						event.createdAt,
					);
					if (event.role === "user") {
						yield* updateChatLastUserMessage(
							sql,
							record.streamId,
							event.createdAt,
						);
					}
					return;
				}
				case "ProviderSessionReserved":
					yield* sql`UPDATE sessions SET provider_reservation_id = ${event.providerSessionId} WHERE id = ${record.streamId}`;
					return;
				case "ProviderAttached":
					yield* sql`UPDATE sessions SET provider_reservation_id = NULL WHERE id = ${record.streamId} AND provider_reservation_id IS NOT ${event.providerSessionId ?? null}`;
					return;
				case "ProviderStopRequested":
				case "ProviderDetached":
					yield* sql`UPDATE sessions SET provider_reservation_id = NULL WHERE id = ${record.streamId} AND provider_reservation_id = ${event.providerSessionId ?? null}`;
					return;
				case "SegmentOpened":
				case "SegmentSettled":
				case "PermissionRequested":
				case "PermissionResolved":
				case "QuestionResolved":
				case "ProviderTurnRequested":
				case "SuccessorTurnScheduled":
				case "ScheduledSuccessorReady":
					return;
			}
		}),
	};
};
