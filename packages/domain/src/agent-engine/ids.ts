import type { ProviderId } from "@zuse/contracts";
import {
	AgentTurnId,
	AttemptId,
	CheckpointId,
	CheckpointScopeId,
	CommandId,
	ContextHandoffId,
	ContextLinkId,
	EventId,
	InputRequestId,
	JobId,
	MessageId,
	ProviderThreadId,
	ProviderTurnId,
	StepId,
	TimelineItemId,
} from "@zuse/contracts";

/**
 * Agent Engine id allocation.
 *
 * Two families:
 *   - `allocate.*` mints a fresh id with a random suffix. Use for entities the
 *     app creates on its own initiative (turns from a user message, commands).
 *   - `derive.*` is pure and content-addressed. Use whenever the same logical
 *     entity can be observed more than once: a provider re-emitting a native
 *     item after a reconnect, a wake-buffer replay, a retried command. The
 *     derived id makes the second observation an upsert, not a duplicate.
 *
 * Provider-native ids never become app ids directly; they are folded into a
 * derived app id together with their scope so ids recycled across providers or
 * threads cannot collide.
 */

const encode = (part: string | number): string =>
	encodeURIComponent(String(part));

/** Joins id parts with `:` after percent-encoding each part. */
export const joinId = (...parts: ReadonlyArray<string | number>): string =>
	parts.map(encode).join(":");

export type TurnSignal = "interrupt-requested" | "interrupt-result";

/** Scope historical or newly allocated provider handles to their owning session. */
export const scopeProviderThreadId = (
	sessionId: string,
	threadId: string,
): ProviderThreadId => {
	const prefix = `${joinId("provider-thread", "session", sessionId)}:`;
	return ProviderThreadId.make(
		threadId.startsWith(prefix) ? threadId : `${prefix}${encode(threadId)}`,
	);
};

export const derive = {
	turn: (input: { readonly sessionId: string; readonly ordinal: number }) =>
		AgentTurnId.make(
			joinId("turn", "session", input.sessionId, "ordinal", input.ordinal),
		),

	attempt: (input: { readonly turnId: string; readonly ordinal: number }) =>
		AttemptId.make(
			joinId("attempt", "turn", input.turnId, "ordinal", input.ordinal),
		),

	rootStep: (input: {
		readonly turnId: string;
		readonly attemptOrdinal: number;
	}) =>
		StepId.make(
			joinId(
				"step",
				"turn",
				input.turnId,
				"attempt",
				input.attemptOrdinal,
				"root",
			),
		),

	providerThread: (input: {
		readonly sessionId: string;
		readonly provider: ProviderId;
		readonly nativeThreadId: string;
	}) =>
		scopeProviderThreadId(
			input.sessionId,
			joinId(
				"provider-thread",
				"provider",
				input.provider,
				"native-thread",
				input.nativeThreadId,
			),
		),

	providerTurn: (input: {
		readonly provider: ProviderId;
		readonly nativeTurnId: string;
	}) =>
		ProviderTurnId.make(
			joinId(
				"provider-turn",
				"provider",
				input.provider,
				"native-turn",
				input.nativeTurnId,
			),
		),

	providerTurnByOrdinal: (input: {
		readonly providerThreadId: string;
		readonly ordinal: number;
	}) =>
		ProviderTurnId.make(
			joinId(
				"provider-turn",
				"provider-thread",
				input.providerThreadId,
				"ordinal",
				input.ordinal,
			),
		),

	stepFromProviderItem: (input: {
		readonly provider: ProviderId;
		readonly nativeItemId: string;
	}) =>
		StepId.make(
			joinId(
				"step",
				"provider",
				input.provider,
				"native-item",
				input.nativeItemId,
			),
		),

	messageFromProviderItem: (input: {
		readonly provider: ProviderId;
		readonly nativeItemId: string;
	}) =>
		MessageId.make(
			joinId(
				"message",
				"provider",
				input.provider,
				"native-item",
				input.nativeItemId,
			),
		),

	timelineItemFromProviderItem: (input: {
		readonly provider: ProviderId;
		readonly nativeItemId: string;
	}) =>
		TimelineItemId.make(
			joinId(
				"timeline",
				"provider",
				input.provider,
				"native-item",
				input.nativeItemId,
			),
		),

	userTimelineItem: (input: { readonly messageId: string }) =>
		TimelineItemId.make(joinId("timeline", "user-message", input.messageId)),

	turnSignalTimelineItem: (input: {
		readonly turnId: string;
		readonly signal: TurnSignal;
	}) =>
		TimelineItemId.make(joinId("timeline", "turn", input.turnId, input.signal)),

	requestStep: (input: { readonly requestId: string }) =>
		StepId.make(joinId("step", "input-request", input.requestId)),

	requestTimelineItem: (input: { readonly requestId: string }) =>
		TimelineItemId.make(joinId("timeline", "input-request", input.requestId)),

	checkpointScope: (input: {
		readonly sessionId: string;
		readonly name: string;
	}) =>
		CheckpointScopeId.make(
			joinId(
				"checkpoint-scope",
				"session",
				input.sessionId,
				"name",
				input.name,
			),
		),

	checkpoint: (input: {
		readonly scopeId: string;
		readonly ordinalWithinScope: number;
	}) =>
		CheckpointId.make(
			joinId(
				"checkpoint",
				"scope",
				input.scopeId,
				"ordinal",
				input.ordinalWithinScope,
			),
		),

	/**
	 * Jobs derive from the command that requested them, so a retried command
	 * enqueues the same job id and the ledger collapses the duplicate.
	 */
	job: (input: {
		readonly commandId: string;
		readonly kind: string;
		readonly target: string;
	}) => JobId.make(joinId("job", input.commandId, input.kind, input.target)),
} as const;

export interface IdAllocator {
	readonly command: (scope: string) => CommandId;
	readonly event: (sessionId: string) => EventId;
	readonly turn: (sessionId: string) => AgentTurnId;
	readonly attempt: (turnId: string) => AttemptId;
	readonly step: (sessionId: string) => StepId;
	readonly providerThread: (provider: ProviderId) => ProviderThreadId;
	readonly providerTurn: (providerThreadId: string) => ProviderTurnId;
	readonly inputRequest: (providerTurnId: string) => InputRequestId;
	readonly timelineItem: (sessionId: string) => TimelineItemId;
	readonly contextLink: (sessionId: string) => ContextLinkId;
	readonly contextHandoff: (sessionId: string) => ContextHandoffId;
}

/**
 * Builds the random id family on top of an injected id source, matching how
 * `makeSessionDomain` receives `() => crypto.randomUUIDv7`. Tests pass a
 * deterministic counter so allocated ids are stable in fixtures.
 */
export const makeIdAllocator = (randomId: () => string): IdAllocator => ({
	command: (scope) => CommandId.make(joinId("command", scope, randomId())),
	event: (sessionId) =>
		EventId.make(joinId("event", "session", sessionId, randomId())),
	turn: (sessionId) =>
		AgentTurnId.make(joinId("turn", "session", sessionId, randomId())),
	attempt: (turnId) =>
		AttemptId.make(joinId("attempt", "turn", turnId, randomId())),
	step: (sessionId) =>
		StepId.make(joinId("step", "session", sessionId, randomId())),
	providerThread: (provider) =>
		ProviderThreadId.make(
			joinId("provider-thread", "provider", provider, randomId()),
		),
	providerTurn: (providerThreadId) =>
		ProviderTurnId.make(
			joinId("provider-turn", "provider-thread", providerThreadId, randomId()),
		),
	inputRequest: (providerTurnId) =>
		InputRequestId.make(
			joinId("input-request", "provider-turn", providerTurnId, randomId()),
		),
	timelineItem: (sessionId) =>
		TimelineItemId.make(joinId("timeline", "session", sessionId, randomId())),
	contextLink: (sessionId) =>
		ContextLinkId.make(
			joinId("context-link", "session", sessionId, randomId()),
		),
	contextHandoff: (sessionId) =>
		ContextHandoffId.make(
			joinId("context-handoff", "session", sessionId, randomId()),
		),
});

export const defaultIdAllocator: IdAllocator = makeIdAllocator(() =>
	crypto.randomUUID(),
);
