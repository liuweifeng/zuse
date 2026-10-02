import type {
	AgentEvent,
	AgentItemId,
	AgentTurnId,
	AttemptId,
	ProviderAttemptOwnership,
	ProviderEventEnvelope,
} from "@zuse/contracts";
import { Deferred, Effect, Ref, Schema, Stream } from "effect";
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

type ActiveTurn = {
	readonly turnId: AgentTurnId;
	readonly released: Deferred.Deferred<void>;
	readonly sent: boolean;
	/** `provider` turns were opened by `ProviderTurnStarted`, not by `send`. */
	readonly origin: "application" | "provider";
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

const parentItemIdOf = (event: AgentEvent): string | undefined =>
	"parentItemId" in event && typeof event.parentItemId === "string"
		? event.parentItemId
		: undefined;

/** Events whose own `itemId` refers back to an earlier `ToolUse`. */
const referencesToolUse = (
	event: AgentEvent,
): event is Extract<AgentEvent, { readonly itemId: AgentItemId }> =>
	event._tag === "ToolUse" ||
	event._tag === "ToolResult" ||
	event._tag === "SubagentSummary";

/**
 * Converts every legacy provider handle at one kernel boundary. This is the
 * only place allowed to correlate native events with an application turn.
 * The server admits at most one provider turn through this handle, so a new
 * send cannot silently supersede an unsettled turn.
 *
 * Work can outlive the turn that started it: background sub-agents and shells
 * keep emitting after their parent turn settles. Those events are attributed
 * to the turn whose `ToolUse` spawned them rather than dropped or folded into
 * whichever turn is current. When the provider starts a top-level turn on its
 * own (`ProviderTurnStarted`), a provider-origin turn is opened for it.
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
							},
						] as const;
					},
				).pipe(Effect.flatMap(releaseBatch));
			}
			return Ref.modify(
				activeTurn,
				(active): readonly [NormalizedBatch, ActiveTurn | null] => {
					if (sessionEventTags.has(event._tag)) {
						return [{ events: [sessionEnvelope(event)] }, active] as const;
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

					const origin = originTurnOf(event);
					if (origin !== undefined && origin !== active?.turnId) {
						rememberItem(event, origin);
						return [{ events: [turnEnvelope(origin, event)] }, active] as const;
					}

					if (active === null) {
						// A provider may reissue a durable blocking question while restoring
						// its own cursor after the application turn was settled during process
						// recovery. Preserve it as a session-scoped availability signal: the
						// conversation runtime will not persist it as a new turn event, while
						// ProviderService can reattach the live callback authority.
						return event._tag === "UserQuestion"
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
			).pipe(Effect.flatMap(releaseBatch));
		};

		const finalizeUnexpectedExit = Ref.modify(
			activeTurn,
			(active): readonly [NormalizedBatch, ActiveTurn | null] => {
				if (active === null) return [{ events: [] }, null] as const;
				return [
					{
						events: [
							turnEnvelope(active.turnId, {
								_tag: "Error",
								message: "Provider event stream ended before the turn settled",
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
		);

		const sourceEvents = handle.events.pipe(
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
									{ turnId, released, sent: true, origin: "application" },
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
							{ turnId, released, sent: true, origin: "application" },
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
					yield* handle.interrupt();
					yield* Deferred.await(active.released);
				}),
		};
	});
