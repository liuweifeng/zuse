import type {
	AgentEvent,
	AgentTurnId,
	AttemptId,
	ProviderAttemptOwnership,
	ProviderEventEnvelope,
} from "@zuse/contracts";
import { Deferred, Effect, Queue, Ref, Schema, Stream } from "effect";
import type {
	ProviderDriverEvent,
	ProviderSessionHandle,
	QuestionCallbackReleased,
} from "./driver.ts";

export type TurnScopedProviderEventEnvelope =
	| ProviderEventEnvelope
	| {
			readonly scope: "session";
			readonly ownership?: ProviderAttemptOwnership;
			readonly event: QuestionCallbackReleased;
	  };

type NativeChild = Extract<AgentEvent, { _tag: "ToolUse" }> & {
	readonly subagent: {
		readonly childSessionId: string;
		readonly presentation: "inline" | "detached";
	};
};

type ActiveTurn = {
	readonly turnId: AgentTurnId;
	readonly released: Deferred.Deferred<void>;
	readonly sent: boolean;
	/** `provider` turns were opened by `ProviderTurnStarted`, not by `send`. */
	readonly origin: "application" | "provider";
	readonly children: ReadonlyMap<string, NativeChild>;
	readonly completedChildren: ReadonlySet<string>;
	readonly pendingCompletion?: Extract<AgentEvent, { _tag: "Completed" }>;
};

/**
 * Upper bound on remembered tool-use origins. Background work only needs the
 * anchors of recent turns; the oldest entries are evicted first.
 */
const MAX_ITEM_TURNS = 4096;

const terminalEventTags = new Set<AgentEvent["_tag"]>([
	"Completed",
	"Interrupted",
	"Error",
]);

type NormalizedBatch = {
	readonly events: ReadonlyArray<TurnScopedProviderEventEnvelope>;
	readonly released?: Deferred.Deferred<void>;
};

export class ProviderHandleUnavailable extends Schema.TaggedErrorClass<ProviderHandleUnavailable>()(
	"ProviderHandleUnavailable",
	{ reason: Schema.String },
) {}

export interface TurnScopedProviderSessionHandle
	extends Omit<ProviderSessionHandle, "events" | "send" | "interrupt"> {
	readonly events: Stream.Stream<TurnScopedProviderEventEnvelope>;
	readonly send: (
		turnId: AgentTurnId,
		...args: Parameters<ProviderSessionHandle["send"]>
	) => Effect.Effect<void, ProviderHandleUnavailable>;
	readonly interrupt: (turnId: AgentTurnId) => Effect.Effect<void>;
}

const sessionEventTags = new Set<AgentEvent["_tag"]>([
	"Started",
	"Auth",
	"Version",
	"Capabilities",
	"SessionCursor",
	"ProviderNotificationMetadata",
	"PermissionModeChanged",
	"GoalUpdated",
	"GoalCleared",
	"UsageLimit",
]);

const sessionEnvelope = (
	event: AgentEvent | QuestionCallbackReleased,
): TurnScopedProviderEventEnvelope => {
	if (event._tag === "QuestionCallbackReleased") {
		return { scope: "session", event };
	}
	return { scope: "session", event };
};

const turnEnvelope = (
	turnId: AgentTurnId,
	event: AgentEvent,
): ProviderEventEnvelope => ({ scope: "turn", turnId, event });

/**
 * Converts every legacy provider handle at one kernel boundary. This is the
 * only place allowed to correlate native events with an application turn.
 * The server admits at most one provider turn through this handle, so a new
 * send cannot silently supersede an unsettled turn.
 */
export const makeTurnScopedSessionHandle = (
	handle: ProviderSessionHandle,
	initialTurnId?: AgentTurnId,
	initialAttemptId?: AttemptId,
): Effect.Effect<TurnScopedProviderSessionHandle> =>
	Effect.gen(function* () {
		if (initialAttemptId !== undefined && initialTurnId === undefined)
			return yield* Effect.die(
				new Error("An attempt-bound handle requires a turn id"),
			);
		const ownership =
			initialTurnId !== undefined && initialAttemptId !== undefined
				? { turnId: initialTurnId, attemptId: initialAttemptId }
				: undefined;
		const injected = yield* Queue.unbounded<ProviderDriverEvent>();
		const finished = yield* Ref.make(false);
		const ended = yield* Ref.make(false);
		const initialReleased = yield* Deferred.make<void>();
		const activeTurn = yield* Ref.make<ActiveTurn | null>(
			initialTurnId === undefined || ownership !== undefined
				? null
				: {
						turnId: initialTurnId,
						released: initialReleased,
						sent: false,
						origin: "application",
						children: new Map<string, NativeChild>(),
						completedChildren: new Set<string>(),
					},
		);
		// Tool-use item id → the turn that emitted it. Insertion order doubles as
		// eviction order.
		const itemTurns = new Map<string, AgentTurnId>();
		const rememberItem = (event: AgentEvent, turnId: AgentTurnId) => {
			if (event._tag !== "ToolUse") return;
			itemTurns.delete(event.itemId);
			itemTurns.set(event.itemId, turnId);
			if (itemTurns.size > MAX_ITEM_TURNS) {
				const oldest = itemTurns.keys().next().value;
				if (oldest !== undefined) itemTurns.delete(oldest);
			}
		};
		const originTurnOf = (event: AgentEvent): AgentTurnId | undefined => {
			if (terminalEventTags.has(event._tag)) return undefined;
			const parent = parentItemIdOf(event);
			const fromParent =
				parent === undefined ? undefined : itemTurns.get(parent);
			if (fromParent !== undefined) return fromParent;
			return referencesToolUse(event) ? itemTurns.get(event.itemId) : undefined;
		};
		const releaseBatch = (
			batch: NormalizedBatch,
		): Effect.Effect<ReadonlyArray<TurnScopedProviderEventEnvelope>> =>
			(batch.released === undefined
				? Effect.void
				: Deferred.succeed(batch.released, undefined).pipe(
						Effect.andThen(Ref.set(finished, true)),
					)
			).pipe(
				Effect.as(
					batch.events.map((envelope) =>
						ownership === undefined ? envelope : { ...envelope, ownership },
					),
				),
			);

		const normalize = (
			event: ProviderDriverEvent,
		): Effect.Effect<ReadonlyArray<TurnScopedProviderEventEnvelope>> => {
			if (event._tag === "QuestionCallbackReleased") {
				return releaseBatch({ events: [sessionEnvelope(event)] });
			}
			if (event._tag === "ProviderTurnStarted") {
				return Ref.modify(
					activeTurn,
					(active): readonly [NormalizedBatch, ActiveTurn | null] => {
						// Already inside a turn: the provider is continuing it.
						if (active !== null) return [{ events: [] }, active] as const;
						const turnId = `turn_${crypto.randomUUID()}` as AgentTurnId;
						return [
							{ events: [turnEnvelope(turnId, event)] },
							{
								turnId,
								released: Deferred.makeUnsafe<void>(),
								sent: true,
								origin: "provider",
								children: new Map<string, NativeChild>(),
								completedChildren: new Set<string>(),
							},
						] as const;
					},
				).pipe(Effect.flatMap(releaseBatch));
			}
			const quiesce = Effect.gen(function* () {
				const active = yield* Ref.get(activeTurn);
				if (
					active !== null &&
					active.children.size > 0 &&
					(event._tag === "Interrupted" ||
						event._tag === "Error" ||
						(event._tag === "Completed" &&
							(event.reason === "error" || event.reason === "interrupted")))
				) {
					// Native terminal signals may precede detached process exit. Do not
					// publish terminal ownership or allow checkpoints until close joins it.
					yield* handle.close();
				}
			});
			return quiesce.pipe(
				Effect.andThen(
					Ref.modify(
						activeTurn,
						(active): readonly [NormalizedBatch, ActiveTurn | null] => {
							if (sessionEventTags.has(event._tag)) {
								return [{ events: [sessionEnvelope(event)] }, active] as const;
							}

							const origin = originTurnOf(event);
							if (origin !== undefined && origin !== active?.turnId) {
								rememberItem(event, origin);
								return [
									{ events: [turnEnvelope(origin, event)] },
									active,
								] as const;
							}

							if (
								active?.pendingCompletion !== undefined &&
								event._tag !== "Completed" &&
								event._tag !== "Interrupted" &&
								event._tag !== "Error" &&
								event._tag !== "Status"
							) {
								const known =
									event._tag === "SubagentSummary"
										? active.children.has(event.itemId)
										: event._tag === "SubagentProgress"
											? [...active.children.values()].some(
													(child) =>
														child.subagent.childSessionId ===
														event.childSessionId,
												)
											: "parentItemId" in event &&
												event.parentItemId !== undefined &&
												active.children.has(event.parentItemId);
								if (!known) return [{ events: [] }, active];
							}
							if (
								active !== null &&
								event._tag === "ToolUse" &&
								event.subagent !== undefined
							) {
								if (active.completedChildren.has(event.itemId))
									return [{ events: [] }, active];
								rememberItem(event, active.turnId);
								const children = new Map(active.children);
								children.set(event.itemId, {
									...event,
									subagent: event.subagent,
								});
								return [
									{ events: [turnEnvelope(active.turnId, event)] },
									{ ...active, children },
								];
							}
							if (active !== null && event._tag === "SubagentSummary") {
								const children = new Map(active.children);
								children.delete(event.itemId);
								const completedChildren = new Set(active.completedChildren);
								completedChildren.add(event.itemId);
								const events = [turnEnvelope(active.turnId, event)];
								if (
									children.size === 0 &&
									active.pendingCompletion !== undefined
								) {
									events.push(
										turnEnvelope(active.turnId, active.pendingCompletion),
									);
									return [{ events, released: active.released }, null];
								}
								return [{ events }, { ...active, children, completedChildren }];
							}
							if (
								active !== null &&
								active.children.size > 0 &&
								((event._tag === "Completed" &&
									event.reason !== "error" &&
									event.reason !== "interrupted") ||
									(event._tag === "Status" && event.status === "idle"))
							) {
								const completed =
									event._tag === "Completed"
										? event
										: { _tag: "Completed" as const, reason: "ended" as const };
								if (active.pendingCompletion !== undefined)
									return [{ events: [] }, active];
								const events = [...active.children.values()].map((child) =>
									turnEnvelope(active.turnId, {
										_tag: "SubagentProgress",
										childId: child.itemId,
										parentId: child.itemId,
										childSessionId: child.subagent.childSessionId,
										status: "running",
										rootCompleted: true,
										durationMs: 0,
										turns: 0,
										toolCalls: 0,
										tokens: 0,
										contextPercentage: 0,
										toolsUsed: [],
										errorCount: 0,
									}),
								);
								return [
									{ events },
									{ ...active, pendingCompletion: completed },
								];
							}
							if (event._tag === "Status") {
								if (active !== null && event.status === "idle") {
									return [
										{
											events: [
												turnEnvelope(active.turnId, {
													_tag: "Completed",
													reason: "ended",
												}),
												sessionEnvelope(event),
											],
											released: active.released,
										},
										null,
									] as const;
								}
								if (
									active !== null &&
									(event.status === "closed" || event.status === "error")
								) {
									return [
										{
											events: [
												turnEnvelope(active.turnId, {
													_tag: "Error",
													message: `Provider entered ${event.status} state`,
												}),
												turnEnvelope(active.turnId, {
													_tag: "Completed",
													reason: "error",
												}),
												sessionEnvelope(event),
											],
											released: active.released,
										},
										null,
									] as const;
								}
								return [{ events: [sessionEnvelope(event)] }, active] as const;
							}

							if (active === null) {
								// A provider may reissue a durable blocking question while restoring
								// its own cursor after the application turn was settled during process
								// recovery. Keep both request and resolution session-scoped so the
								// runtime can persist their lifecycle without inventing a turn.
								return event._tag === "UserQuestion" ||
									event._tag === "UserQuestionResolved"
									? [{ events: [sessionEnvelope(event)] }, null]
									: [{ events: [] }, null];
							}

							if (event._tag === "Completed") {
								return [
									{
										events: [turnEnvelope(active.turnId, event)],
										released: active.released,
									},
									null,
								] as const;
							}
							if (event._tag === "Interrupted") {
								return [
									{
										events: [
											turnEnvelope(active.turnId, event),
											turnEnvelope(active.turnId, {
												_tag: "Completed",
												reason: "interrupted",
											}),
										],
										released: active.released,
									},
									null,
								] as const;
							}
							if (event._tag === "Error") {
								return [
									{
										events: [
											turnEnvelope(active.turnId, event),
											turnEnvelope(active.turnId, {
												_tag: "Completed",
												reason: "error",
											}),
										],
										released: active.released,
									},
									null,
								] as const;
							}
							rememberItem(event, active.turnId);
							return [
								{ events: [turnEnvelope(active.turnId, event)] },
								active,
							] as const;
						},
					),
				),
				Effect.flatMap(releaseBatch),
			);
		};

		const finalizeUnexpectedExit = Effect.gen(function* () {
			const active = yield* Ref.get(activeTurn);
			if (active !== null && active.children.size > 0) yield* handle.close();
		}).pipe(
			Effect.andThen(
				Ref.modify(
					activeTurn,
					(active): readonly [NormalizedBatch, ActiveTurn | null] => {
						if (active === null) return [{ events: [] }, null] as const;
						return [
							{
								events: [
									turnEnvelope(active.turnId, {
										_tag: "Error",
										message:
											"Provider event stream ended before the turn settled",
									}),
									turnEnvelope(active.turnId, {
										_tag: "Completed",
										reason: "error",
									}),
								],
								released: active.released,
							},
							null,
						] as const;
					},
				).pipe(
					Effect.tap(() => Ref.set(ended, true)),
					Effect.flatMap(releaseBatch),
				),
			),
		);

		const sourceEvents = handle.events.pipe(
			Stream.merge(Stream.fromQueue(injected), { haltStrategy: "left" }),
			Stream.catchCause((cause) =>
				Stream.fromIterable<AgentEvent>([
					{
						_tag: "Error",
						message: `Provider event stream failed: ${String(cause)}`,
					},
				]),
			),
		);
		const normalizedEvents = Stream.mapEffect(sourceEvents, normalize).pipe(
			Stream.flatMap((events) => Stream.fromIterable(events)),
			Stream.concat(
				Stream.fromEffect(finalizeUnexpectedExit).pipe(
					Stream.flatMap((events) => Stream.fromIterable(events)),
				),
			),
		);

		return {
			...handle,
			events: normalizedEvents,
			send: (turnId, ...args) =>
				Effect.gen(function* () {
					if (ownership !== undefined) {
						if (turnId !== ownership.turnId)
							return yield* Effect.die(
								new Error("A provider attempt requires its own handle"),
							);
						if (yield* Ref.get(finished)) return;
					}
					if (yield* Ref.get(ended))
						return yield* new ProviderHandleUnavailable({
							reason: "Provider event stream ended before send",
						});
					const released = yield* Deferred.make<void>();
					const send = yield* Ref.modify(activeTurn, (active) => {
						if (active !== null) {
							if (active.turnId === turnId) {
								return active.sent
									? ([Effect.void, active] as const)
									: ([
											handle.send(...args),
											{ ...active, sent: true },
										] as const);
							}
							if (active.origin === "provider") {
								// The provider opened its own turn while the application was
								// admitting this one. The server resolves that provider turn
								// onto this application turn, so adopt it: the provider queues
								// this input behind its current work, and everything it emits
								// from here belongs to the application turn.
								return [
									Deferred.succeed(active.released, undefined).pipe(
										Effect.andThen(handle.send(...args)),
									),
									{
										...active,
										turnId,
										released,
										sent: true,
										origin: "application",
									},
								] as const;
							}
							return [
								Effect.die(
									new Error(
										`Cannot start turn ${turnId}; turn ${active.turnId} is still active`,
									),
								),
								active,
							] as const;
						}
						return [
							handle.send(...args),
							{
								turnId,
								released,
								sent: true,
								origin: "application",
								children: new Map<string, NativeChild>(),
								completedChildren: new Set<string>(),
							},
						] as const;
					});
					yield* send.pipe(
						Effect.catchCause((cause) =>
							Ref.modify(activeTurn, (active) =>
								active?.turnId === turnId
									? [active.released, null]
									: [undefined, active],
							).pipe(
								Effect.flatMap((currentReleased) =>
									currentReleased === undefined
										? Effect.void
										: Deferred.succeed(currentReleased, undefined),
								),
								Effect.andThen(Effect.failCause(cause)),
							),
						),
					);
				}),
			interrupt: (turnId) =>
				Effect.gen(function* () {
					const active = yield* Ref.get(activeTurn);
					if (active?.turnId !== turnId) {
						return yield* Effect.die(
							new Error(
								`Cannot interrupt turn ${turnId}; current turn is ${active?.turnId ?? "none"}`,
							),
						);
					}
					if (active.pendingCompletion !== undefined) {
						yield* Queue.offer(injected, { _tag: "Interrupted" });
					} else {
						yield* handle.interrupt();
					}
					yield* Deferred.await(active.released);
				}),
		};
	});
