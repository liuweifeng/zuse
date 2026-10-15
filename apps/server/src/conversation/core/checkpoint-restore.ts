import {
	AgentTurnId,
	NativeHistoryCheckpoint,
	SessionCheckpointError,
	type SessionCheckpointSummary,
	SessionId,
} from "@zuse/contracts";
import { providerThreadIdFor } from "@zuse/domain/core/state";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import type { SqlSessionQueriesApi } from "@zuse/domain/queries/sql-session-queries";
import {
	captureGitCheckpoint,
	checkpointChangedFiles,
	GitCheckpointPreconditionError,
	restoreGitCheckpoint,
	validateGitCheckpointRestore,
} from "@zuse/git/checkpoints";
import { Effect, Schema, Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import { isEngineIdle } from "../../runtime-idle.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { makeContextHandoff } from "./context-handoff.ts";
import { invalidateContextLinksForRollback } from "./context-links.ts";
import { makeProviderContexts } from "./provider-contexts.ts";

interface CheckpointRow {
	id: string;
	session_id: string;
	turn_id: string;
	phase: "baseline" | "final";
	status: SessionCheckpointSummary["status"];
	cwd: string;
	project_id: string;
	worktree_id: string | null;
	message_sequence: number;
	captured_at: number | null;
	error: string | null;
	restore_id?: string | null;
	turn_ordinal: number;
	scope_id: string;
	root_step_id: string | null;
	native_history_json: string | null;
}
interface RestoreRow {
	id: string;
	session_id: string;
	target_id: string;
	expected_id: string;
	cwd: string;
	status: string;
	created_at: number;
	completed_at: number | null;
	through_ordinal: number;
	removed_message_ids_json: string;
	native_attempted: number;
}
const failure = (message: string) => new SessionCheckpointError({ message });
const fileEffect = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (error) =>
			failure(
				error instanceof Error
					? error.message
					: "Checkpoint files could not be restored.",
			),
	});

/** Durable restore saga. The admission fence remains closed on uncertain failures. */
export const makeCheckpointRestore = Effect.fn("CheckpointRestore.make")(
	function* (options: {
		sql: SqlClient.SqlClient;
		domain: SessionDomainApi;
		getSession: ConversationOperations["getSession"];
		provider: Pick<
			ProviderServiceShape,
			"close" | "hasSession" | "quiesce" | "restoreHistoryCheckpoint"
		>;
		activeTurnCount: SqlSessionQueriesApi["activeTurnCount"];
		teardown: (sessionId: SessionId) => Effect.Effect<void>;
		retryFinalization: (sessionId: SessionId) => Effect.Effect<void>;
	}) {
		const { sql, domain, getSession, provider, teardown } = options;
		const mutex = yield* Semaphore.make(1);
		const getTarget = (sessionId: SessionId, id: string) =>
			Effect.gen(function* () {
				const rows =
					yield* sql<CheckpointRow>`SELECT * FROM session_checkpoints WHERE id=${id} AND session_id=${sessionId}`;
				const row = rows[0];
				if (row === undefined || row.status !== "ready")
					return yield* failure("This checkpoint is unavailable or stale.");
				return row;
			});
		const list = (sessionId: SessionId) =>
			Effect.gen(function* () {
				yield* getSession(sessionId).pipe(
					Effect.mapError(() => failure("Session not found.")),
				);
				const rows =
					yield* sql<CheckpointRow>`SELECT c.*, (SELECT t.ordinal FROM session_turns t WHERE t.id=c.turn_id) AS turn_ordinal, (SELECT r.id FROM session_checkpoint_restores r WHERE r.target_id=c.id AND r.completed_at IS NULL LIMIT 1) AS restore_id FROM session_checkpoints c WHERE session_id=${sessionId} ORDER BY created_at,id`;
				return rows.map((row) => ({
					id: row.id,
					turnId: AgentTurnId.make(row.turn_id),
					turnOrdinal: row.turn_ordinal,
					scopeId: row.scope_id,
					rootStepId: row.root_step_id,
					rollbackCapability: "turn_boundary" as const,
					phase: row.phase,
					status: row.status,
					capturedAt: row.captured_at,
					error: row.error,
					restoreId: row.restore_id ?? null,
				}));
			}).pipe(
				Effect.catchTag("SqlError", () =>
					Effect.fail(failure("Could not load checkpoints.")),
				),
			);
		const preview = (sessionId: SessionId, checkpointId: string) =>
			Effect.gen(function* () {
				const target = yield* getTarget(sessionId, checkpointId);
				const previewId = crypto.randomUUID();
				const expectedId = `restore-preview:${previewId}`;
				yield* fileEffect(() => captureGitCheckpoint(target.cwd, expectedId));
				const files = yield* fileEffect(() =>
					checkpointChangedFiles(target.cwd, target.id, expectedId),
				);
				const createdAt = Date.now();
				yield* sql`INSERT INTO session_checkpoint_previews(id,session_id,target_id,expected_id,cwd,created_at) VALUES(${previewId},${sessionId},${target.id},${expectedId},${target.cwd},${createdAt})`;
				return { previewId, files, expiresAt: createdAt + 600_000 };
			}).pipe(
				Effect.catchTag("SqlError", () =>
					Effect.fail(failure("Could not prepare rollback.")),
				),
			);
		const apply = (sessionId: SessionId, previewId: string) =>
			Effect.gen(function* () {
				const previews =
					yield* sql<RestoreRow>`SELECT * FROM session_checkpoint_previews WHERE id=${previewId} AND session_id=${sessionId}`;
				const preview = previews[0];
				if (preview === undefined)
					return yield* failure("Rollback preview not found.");
				const prior =
					yield* sql<RestoreRow>`SELECT * FROM session_checkpoint_restores WHERE id=${previewId} AND session_id=${sessionId}`;
				if (prior[0]?.status === "cancelled")
					return yield* failure(
						"This preview was cancelled because files changed. Review a fresh preview.",
					);
				if (prior[0]?.completed_at != null) return;
				const target = yield* getTarget(sessionId, preview.target_id);
				if (prior.length === 0) {
					if (preview.created_at + 600_000 < Date.now())
						return yield* failure(
							"Rollback preview expired. Review the current changes again.",
						);
					yield* domain.admission
						.run(
							Effect.gen(function* () {
								const idle = yield* isEngineIdle({
									sql,
									domain,
									activeTurnCount: options.activeTurnCount,
									hasSession: provider.hasSession,
								}).pipe(Effect.orDie);
								const queued = yield* sql<{
									busy: number;
								}>`SELECT EXISTS(SELECT 1 FROM queued_messages WHERE session_id=${sessionId}) AS busy`;
								if (!idle || queued[0]?.busy === 1)
									return yield* failure(
										"Wait for active engine work to finish and clear this session's queued messages before rollback.",
									);
								const turns = yield* sql<{
									ordinal: number;
								}>`SELECT ordinal FROM session_turns WHERE session_id=${sessionId} AND id=${target.turn_id}`;
								const ordinal = turns[0]?.ordinal;
								if (ordinal === undefined)
									return yield* failure("Checkpoint turn is missing.");
								const removed = yield* sql<{
									id: string;
								}>`SELECT id FROM messages WHERE session_id=${sessionId} AND sequence>${target.message_sequence} ORDER BY sequence,id`;
								yield* sql`INSERT INTO session_checkpoint_restores(id,session_id,project_id,worktree_id,cwd,target_id,expected_id,status,through_ordinal,removed_message_ids_json,created_at) VALUES(${previewId},${sessionId},${target.project_id},${target.worktree_id},${target.cwd},${target.id},${preview.expected_id},'prepared',${target.phase === "baseline" ? ordinal - 1 : ordinal},${JSON.stringify(removed.map((row) => row.id))},${Date.now()})`;
							}),
						)
						.pipe(
							Effect.catchTag("AdmissionClosed", () =>
								Effect.fail(failure("The engine is shutting down.")),
							),
						);
				}
				const records =
					yield* sql<RestoreRow>`SELECT * FROM session_checkpoint_restores WHERE id=${previewId}`;
				const operation = records[0];
				if (operation === undefined)
					return yield* failure("Rollback operation is missing.");
				const nativeSnapshot =
					target.native_history_json == null
						? null
						: yield* Schema.decodeUnknownEffect(
								Schema.fromJsonString(NativeHistoryCheckpoint),
							)(target.native_history_json).pipe(
								Effect.catch(() => Effect.succeed(null)),
							);
				const currentSession = yield* getSession(sessionId).pipe(Effect.orDie);
				const context = yield* sql<{ unsafe: number }>`SELECT (
     EXISTS(SELECT 1 FROM session_context_links l JOIN messages m ON m.id=l.target_message_id WHERE l.target_session_id=${sessionId} AND m.sequence<=${target.message_sequence})
     OR EXISTS(SELECT 1 FROM session_context_handoffs WHERE session_id=${sessionId} AND active=1 AND first_turn_id IS NULL)
    ) AS unsafe`;
				const nativeCandidate =
					nativeSnapshot !== null &&
					provider.restoreHistoryCheckpoint !== undefined &&
					currentSession.providerId === nativeSnapshot.providerId &&
					currentSession.providerThread?.nativeThreadRef.nativeId ===
						nativeSnapshot.nativeThreadId &&
					context[0]?.unsafe === 0 &&
					(yield* provider.hasSession(sessionId))
						? nativeSnapshot
						: null;
				const closeProvider = (
					provider.quiesce?.(sessionId) ?? provider.close(sessionId)
				).pipe(
					Effect.mapError(() =>
						failure("Could not stop the session provider before rollback."),
					),
				);
				let nativeAttempted = operation.native_attempted === 1;
				const preconditionFailure = (error: GitCheckpointPreconditionError) =>
					Effect.gen(function* () {
						if (prior.length === 0 && !nativeAttempted)
							yield* sql`UPDATE session_checkpoint_restores SET status='cancelled',error=${error.message},completed_at=${Date.now()} WHERE id=${previewId}`;
						return yield* failure(error.message);
					});
				if (nativeCandidate !== null)
					yield* Effect.tryPromise({
						try: () =>
							validateGitCheckpointRestore(
								target.cwd,
								target.id,
								preview.expected_id,
							),
						catch: (cause) =>
							cause instanceof GitCheckpointPreconditionError
								? cause
								: failure("Could not validate files before native rollback."),
					}).pipe(
						Effect.catchTag(
							"GitCheckpointPreconditionError",
							preconditionFailure,
						),
					);
				yield* teardown(sessionId);

				yield* domain
					.dispatch({
						commandId: `rollback:${previewId}:detach`,
						streamId: sessionId,
						command: {
							_tag: "DetachProvider",
							detachedAt: operation.created_at,
						},
					})
					.pipe(Effect.orDie);
				let nativeRestored = false;
				if (
					nativeCandidate !== null &&
					provider.restoreHistoryCheckpoint !== undefined
				) {
					yield* sql`UPDATE session_checkpoint_restores SET native_attempted=1 WHERE id=${previewId}`;
					nativeAttempted = true;
					nativeRestored = yield* provider
						.restoreHistoryCheckpoint(sessionId, nativeCandidate)
						.pipe(Effect.catch(() => Effect.succeed(false)));
					yield* sql`UPDATE session_checkpoint_restores SET native_verified_json=${nativeRestored ? JSON.stringify(nativeCandidate) : null} WHERE id=${previewId}`;
				}
				yield* closeProvider;

				yield* Effect.tryPromise({
					try: () =>
						restoreGitCheckpoint(target.cwd, target.id, preview.expected_id),
					catch: (cause) =>
						cause instanceof GitCheckpointPreconditionError
							? cause
							: failure(
									"File restore did not finish. Retry this rollback to recover safely.",
								),
				}).pipe(
					Effect.catchTag(
						"GitCheckpointPreconditionError",
						preconditionFailure,
					),
				);
				yield* sql`UPDATE session_checkpoint_restores SET status='files_restored',error=NULL WHERE id=${previewId}`;
				const removedIds = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Array(Schema.String)),
				)(operation.removed_message_ids_json).pipe(Effect.orDie);
				yield* domain
					.dispatch({
						commandId: `rollback:${previewId}:transcript`,
						streamId: sessionId,
						command: {
							_tag: "RollbackTurns",
							throughOrdinal: operation.through_ordinal,
							messageSequence: target.message_sequence,
							removedMessageIds: removedIds,
							rolledBackAt: operation.created_at,
						},
					})
					.pipe(Effect.orDie);

				yield* sql.withTransaction(
					Effect.gen(function* () {
						const session = yield* getSession(sessionId).pipe(Effect.orDie);
						yield* invalidateContextLinksForRollback(sql, sessionId);
						if (nativeRestored && nativeCandidate !== null) {
							yield* domain
								.dispatch({
									commandId: `rollback:${previewId}:native`,
									streamId: sessionId,
									command: {
										_tag: "BindProviderThread",
										nativeThreadId: nativeCandidate.nativeThreadId,
										nativeHeadId: nativeCandidate.turnIds.at(-1) ?? null,
										updatedAt: operation.created_at,
									},
								})
								.pipe(Effect.orDie);
							yield* makeProviderContexts(sql).rememberVerified(
								sessionId,
								providerThreadIdFor(
									sessionId,
									session.providerId,
									nativeCandidate.nativeThreadId,
								),
								{
									throughSequence: target.message_sequence,
									pendingMessageIds: [],
								},
							);
							yield* sql`UPDATE session_context_handoffs SET active=0 WHERE session_id=${sessionId} AND active=1`;
						} else {
							yield* makeContextHandoff(sql).capture(
								sessionId,
								session.providerId,
								`rollback:${previewId}:context`,
							);
						}
						yield* sql`UPDATE session_checkpoints SET status='stale' WHERE session_id=${sessionId} AND id<>${target.id} AND turn_id IN (SELECT id FROM session_turns WHERE session_id=${sessionId} AND ordinal>${operation.through_ordinal})`;
						yield* sql`UPDATE session_checkpoint_restores SET status='completed',completed_at=${Date.now()},error=NULL WHERE id=${previewId}`;
					}),
				);
			}).pipe(
				Effect.catchTag("SqlError", () =>
					Effect.fail(
						failure(
							"Could not persist rollback. The checkout remains fenced until retry succeeds.",
						),
					),
				),
			);
		const restore = (sessionId: SessionId, previewId: string) =>
			mutex
				.withPermits(1)(
					apply(sessionId, previewId).pipe(
						Effect.tapError((error) =>
							sql`UPDATE session_checkpoint_restores SET status='error',error=${error.message} WHERE id=${previewId} AND completed_at IS NULL`.pipe(
								Effect.orDie,
							),
						),
					),
				)
				.pipe(Effect.uninterruptible);
		const retry = (sessionId: SessionId) =>
			options.retryFinalization(sessionId);
		const recover = Effect.gen(function* () {
			const rows = yield* sql<{
				id: string;
				session_id: string;
			}>`SELECT id,session_id FROM session_checkpoint_restores WHERE completed_at IS NULL ORDER BY created_at`;
			for (const row of rows)
				yield* restore(SessionId.make(row.session_id), row.id).pipe(
					Effect.catch((error) =>
						Effect.logError(
							`Checkpoint restore remains pending: ${error.message}`,
						),
					),
				);
		}).pipe(Effect.orDie);
		return { list, preview, restore, retry, recover };
	},
);
