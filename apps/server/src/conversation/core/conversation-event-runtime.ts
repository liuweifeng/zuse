/** Owns provider-event subscriptions and durable turn settlement. */
import type {
	AgentItemId,
	AgentTurnId,
	MessageContent,
	PermissionMode,
	ProviderId,
	ProviderTurnReference,
	SessionId,
	ThreadGoal,
} from "@zuse/contracts";
import type {
	AttemptOwnership,
	AttemptOwnershipConflict,
	ProviderSessionOwnershipConflict,
} from "@zuse/domain/engine/dispatch";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	type Scope,
	Semaphore,
	Stream,
} from "effect";

import type {
	ProviderCursorReceipt,
	ProviderEventDelivery,
} from "../../provider/provider-event-delivery.ts";
import { eventToContent } from "./conversation-message-mapping.ts";
import {
	INGESTION_HEARTBEAT_MS,
	type IngestionLease,
	type IngestionLeaseIdentity,
} from "./ingestion-lease.ts";

type ApiActivity =
	| "approval-needed"
	| "question-needed"
	| "completed"
	| "error"
	| "running";

export interface ConversationEventRuntimeOptions {
	readonly scope: Scope.Scope;
	readonly ingestionHeartbeatMs?: number;
	readonly acquireIngestionLease?: (
		sessionId: SessionId,
		identity: IngestionLeaseIdentity,
	) => Effect.Effect<IngestionLease | null>;
	readonly events: (
		sessionId: SessionId,
	) => Stream.Stream<ProviderEventDelivery, unknown>;
	readonly ownsAttempt: (
		sessionId: SessionId,
		ownership: AttemptOwnership,
	) => Effect.Effect<boolean>;
	readonly ownsProviderSession: (
		sessionId: SessionId,
		providerSessionId: string,
	) => Effect.Effect<boolean>;
	readonly providerId: (sessionId: SessionId) => Effect.Effect<ProviderId>;
	readonly settleTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		outcome: "completed" | "interrupted" | "error",
		expectedAttempt?: AttemptOwnership,
		expectedProviderSessionId?: string,
	) => Effect.Effect<
		boolean,
		AttemptOwnershipConflict | ProviderSessionOwnershipConflict
	>;
	/**
	 * Durably starts a turn the provider opened on its own. Resolves to the
	 * proposed id, or to the application turn that is already running when the
	 * two raced (the kernel then adopts the provider turn into it).
	 */
	readonly beginProviderTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
	) => Effect.Effect<AgentTurnId>;
	/** Bind the native execution reported by the owning provider process. */
	readonly bindAttemptProviderTurn: (
		sessionId: SessionId,
		reference: ProviderTurnReference,
		expectedAttempt: AttemptOwnership,
		expectedProviderSessionId: string,
	) => Effect.Effect<
		void,
		AttemptOwnershipConflict | ProviderSessionOwnershipConflict
	>;
	/** Bind the provider-native thread the driver reported for this session. */
	readonly bindProviderThread: (
		sessionId: SessionId,
		nativeThreadId: string,
		nativeHeadId?: string,
		expectedAttempt?: AttemptOwnership,
		expectedProviderSessionId?: string,
	) => Effect.Effect<
		void,
		AttemptOwnershipConflict | ProviderSessionOwnershipConflict
	>;
	readonly setPermissionMode: (
		sessionId: SessionId,
		mode: PermissionMode,
		expectedAttempt?: AttemptOwnership,
		expectedProviderSessionId?: string,
	) => Effect.Effect<
		void,
		AttemptOwnershipConflict | ProviderSessionOwnershipConflict
	>;
	readonly publishGoal: (
		sessionId: SessionId,
		goal: ThreadGoal | null,
	) => Effect.Effect<void>;
	readonly publishApiActivity: (
		sessionId: SessionId,
		activity: ApiActivity,
	) => Effect.Effect<void>;
	readonly reconcileQuestionResolution: (
		sessionId: SessionId,
		itemId: AgentItemId,
	) => Effect.Effect<boolean>;
	readonly ignoreError: (providerId: ProviderId, message: string) => boolean;
	readonly isDuplicateToolUse: (
		sessionId: SessionId,
		content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
	) => Effect.Effect<boolean>;
	readonly persist: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		content: MessageContent,
		providerItemIdentity?: string,
		expectedAttempt?: AttemptOwnership,
		expectedProviderSessionId?: string,
	) => Effect.Effect<
		void,
		AttemptOwnershipConflict | ProviderSessionOwnershipConflict
	>;
}

export interface ConversationEventRuntime {
	readonly start: (
		sessionId: SessionId,
		identity?: IngestionLeaseIdentity,
	) => Effect.Effect<void>;
	readonly interrupt: (sessionId: SessionId) => Effect.Effect<void>;
}

interface SessionEventFiber {
	readonly token: object;
	readonly fiber: Fiber.Fiber<unknown, unknown>;
}

interface SessionLifecycleLock {
	readonly semaphore: Semaphore.Semaphore;
	readonly users: number;
}

export const makeConversationEventRuntime = Effect.fn(
	"ConversationEventRuntime.make",
)(function* (
	options: ConversationEventRuntimeOptions,
): Effect.fn.Return<ConversationEventRuntime> {
	const fibers = yield* Ref.make<ReadonlyMap<SessionId, SessionEventFiber>>(
		new Map(),
	);
	const lifecycleLocks = yield* Ref.make<
		ReadonlyMap<SessionId, SessionLifecycleLock>
	>(new Map());
	const lifecycleLockGuard = yield* Semaphore.make(1);
	const withLifecycle = <A, E, R>(
		sessionId: SessionId,
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E, R> =>
		Effect.gen(function* () {
			const entry = yield* lifecycleLockGuard.withPermits(1)(
				Effect.gen(function* () {
					const existing = (yield* Ref.get(lifecycleLocks)).get(sessionId);
					const entry = existing ?? {
						semaphore: yield* Semaphore.make(1),
						users: 0,
					};
					yield* Ref.update(lifecycleLocks, (current) => {
						const next = new Map(current);
						next.set(sessionId, { ...entry, users: entry.users + 1 });
						return next;
					});
					return entry;
				}),
			);
			const release = lifecycleLockGuard.withPermits(1)(
				Ref.update(lifecycleLocks, (current) => {
					const active = current.get(sessionId);
					if (active === undefined) return current;
					const next = new Map(current);
					if (active.users === 1) next.delete(sessionId);
					else next.set(sessionId, { ...active, users: active.users - 1 });
					return next;
				}),
			);
			return yield* entry.semaphore
				.withPermits(1)(effect)
				.pipe(Effect.ensuring(release));
		});

	const start: ConversationEventRuntime["start"] = (sessionId, identity) =>
		withLifecycle(
			sessionId,
			Effect.gen(function* () {
				const existing = (yield* Ref.get(fibers)).get(sessionId);
				if (existing !== undefined) yield* Fiber.interrupt(existing.fiber);
				const providerId = yield* options.providerId(sessionId);
				const token = {};
				const lease =
					identity === undefined || options.acquireIngestionLease === undefined
						? null
						: yield* options.acquireIngestionLease(sessionId, identity);
				if (
					identity !== undefined &&
					options.acquireIngestionLease !== undefined &&
					lease === null
				)
					return yield* Effect.interrupt;
				let renewLease = true;
				let lastProviderActivityAt: number | undefined;
				let lastRenewedAt = Date.now();
				const heartbeatMs =
					options.ingestionHeartbeatMs ?? INGESTION_HEARTBEAT_MS;
				const heartbeat = Effect.suspend(() =>
					Effect.gen(function* () {
						if (
							!renewLease ||
							lease === null ||
							Date.now() - lastRenewedAt < heartbeatMs
						)
							return;
						if (yield* lease.renew(lastProviderActivityAt)) {
							lastRenewedAt = Date.now();
							return;
						}
						renewLease = false;
						if (
							identity !== undefined &&
							(yield* options.ownsAttempt(sessionId, identity)) &&
							(yield* options.ownsProviderSession(
								sessionId,
								identity.providerSessionId,
							))
						)
							return yield* Effect.interrupt;
					}),
				);

				const events =
					lease === null
						? options.events(sessionId)
						: Stream.merge(
								options.events(sessionId),
								Stream.tick(
									options.ingestionHeartbeatMs ?? INGESTION_HEARTBEAT_MS,
								).pipe(
									Stream.takeWhile(() => renewLease),
									Stream.map(() => null),
								),
								{ haltStrategy: "left" },
							);
				let pendingReceipt: ProviderCursorReceipt | undefined;
				// Provider-opened turns that lost the race to an application turn,
				// mapped onto the application turn that absorbed their events.
				const absorbedProviderTurns = new Map<AgentTurnId, AgentTurnId>();
				const ready = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkIn(
					Deferred.await(ready).pipe(
						Effect.andThen(
							Stream.runForEach(events, (envelope) =>
								Effect.gen(function* () {
									yield* heartbeat.pipe(
										Effect.onExit((exit) =>
											Exit.isFailure(exit)
												? (envelope?.cursorReceipt?.release ?? Effect.void)
												: Effect.void,
										),
									);
									if (envelope === null) return;
									const ownership = envelope.ownership;
									const providerSessionId = envelope.providerSessionId;
									if (
										!(yield* options.ownsProviderSession(
											sessionId,
											providerSessionId,
										))
									) {
										yield* envelope.cursorReceipt?.release ?? Effect.void;
										return;
									}
									if (
										ownership !== undefined &&
										envelope.event._tag !== "SessionCursor" &&
										!(yield* options.ownsAttempt(sessionId, ownership))
									) {
										yield* envelope.cursorReceipt?.release ?? Effect.void;
										return;
									}
									lastProviderActivityAt = Date.now();
									const event = envelope.event;
									if (event._tag === "ProviderTurnStarted") {
										if (envelope.scope !== "turn") return;
										const started = yield* options.beginProviderTurn(
											sessionId,
											envelope.turnId,
										);
										if (started !== envelope.turnId) {
											absorbedProviderTurns.set(envelope.turnId, started);
										}
										yield* options.publishApiActivity(sessionId, "running");
										return;
									}
									const turnId =
										envelope.scope === "turn"
											? (absorbedProviderTurns.get(envelope.turnId) ??
												envelope.turnId)
											: undefined;
									if (event._tag === "ProviderNotificationMetadata") {
										pendingReceipt = envelope.cursorReceipt;
										return;
									}
									if (event._tag === "Status") {
										if (event.status === "running") {
											yield* options.publishApiActivity(sessionId, "running");
										}
										return;
									}
									if (event._tag === "Completed") {
										if (envelope.scope !== "turn" || turnId === undefined)
											return;
										// An absorbed provider turn's terminal belongs to work the
										// application turn has not delivered yet; that turn settles
										// on its own terminal.
										if (absorbedProviderTurns.delete(envelope.turnId)) return;
										const outcome =
											event.reason === "interrupted"
												? "interrupted"
												: event.reason === "error"
													? "error"
													: "completed";
										const settled = yield* options.settleTurn(
											sessionId,
											turnId,
											outcome,
											ownership,
											providerSessionId,
										);
										if (settled === false) return;
										yield* options.publishApiActivity(
											sessionId,
											event.reason === "error" ? "error" : "completed",
										);
										return;
									}
									if (event._tag === "NativeTurnStarted") {
										if (
											envelope.scope === "turn" &&
											ownership !== undefined &&
											event.reference.provider === providerId
										) {
											yield* options.bindAttemptProviderTurn(
												sessionId,
												event.reference,
												ownership,
												providerSessionId,
											);
										}
										return;
									}
									if (event._tag === "SessionCursor") {
										const receipt = envelope.cursorReceipt;
										yield* options
											.bindProviderThread(
												sessionId,
												event.cursor,
												event.providerEventCursor,
												ownership,
												providerSessionId,
											)
											.pipe(
												Effect.onExit((exit) =>
													receipt === undefined
														? Effect.void
														: Exit.isSuccess(exit)
															? receipt.acknowledge
															: receipt.release,
												),
												Effect.ensuring(
													Effect.sync(() => {
														if (
															receipt !== undefined &&
															pendingReceipt?.cursor === receipt.cursor
														)
															pendingReceipt = undefined;
													}),
												),
											);
										return;
									}
									if (event._tag === "PermissionModeChanged") {
										yield* options.setPermissionMode(
											sessionId,
											event.mode,
											ownership,
											providerSessionId,
										);
										return;
									}
									if (event._tag === "GoalUpdated") {
										yield* options.publishGoal(sessionId, event.goal);
										return;
									}
									if (event._tag === "GoalCleared") {
										yield* options.publishGoal(sessionId, null);
										return;
									}
									if (
										event._tag === "Error" &&
										options.ignoreError(providerId, event.message)
									) {
										return;
									}
									if (
										event._tag === "UserQuestion" &&
										(yield* options.reconcileQuestionResolution(
											sessionId,
											event.itemId,
										))
									) {
										return;
									}
									if (envelope.scope !== "turn" || turnId === undefined) return;
									if (event._tag === "PermissionRequest") {
										yield* options.publishApiActivity(
											sessionId,
											"approval-needed",
										);
									}
									if (event._tag === "UserQuestion") {
										yield* options.publishApiActivity(
											sessionId,
											"question-needed",
										);
									}
									const content = eventToContent(event);
									if (content === null) return;
									if (
										content._tag === "tool_use" &&
										(yield* options.isDuplicateToolUse(sessionId, content))
									) {
										return;
									}
									yield* options.persist(
										sessionId,
										turnId,
										content,
										"itemId" in event && typeof event.itemId === "string"
											? `${event._tag}:${event.itemId}`
											: undefined,
										ownership,
										providerSessionId,
									);
									if (event._tag === "Error") {
										yield* options.publishApiActivity(sessionId, "error");
									}
								}).pipe(
									Effect.catchTag(
										[
											"AttemptOwnershipConflict",
											"ProviderSessionOwnershipConflict",
										],
										() => Effect.void,
									),
								),
							),
						),
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								yield* Effect.logDebug(
									"[ConversationEvents] event stream ended",
								);
								yield* Effect.logDebug(cause);
							}),
						),
						Effect.ensuring(lease?.expire ?? Effect.void),
						Effect.ensuring(
							Effect.suspend(() => pendingReceipt?.release ?? Effect.void),
						),
						Effect.ensuring(
							Ref.update(fibers, (current) => {
								if (current.get(sessionId)?.token !== token) return current;
								const next = new Map(current);
								next.delete(sessionId);
								return next;
							}),
						),
					),
					options.scope,
				);
				yield* Ref.update(fibers, (current) => {
					const next = new Map(current);
					next.set(sessionId, { token, fiber });
					return next;
				});
				yield* Deferred.succeed(ready, undefined);
			}),
		);

	const interrupt: ConversationEventRuntime["interrupt"] = (sessionId) =>
		withLifecycle(
			sessionId,
			Effect.gen(function* () {
				const entry = (yield* Ref.get(fibers)).get(sessionId);
				if (entry !== undefined) yield* Fiber.interrupt(entry.fiber);
			}),
		);

	return { start, interrupt };
});
