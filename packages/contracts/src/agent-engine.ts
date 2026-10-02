import { Schema } from "effect";

import { ProviderId, UserQuestion } from "./agent.ts";
import { AttachmentRef } from "./composer.ts";
import {
	AgentSessionId,
	AgentTurnId,
	AttemptId,
	CheckpointId,
	CheckpointScopeId,
	ContextHandoffId,
	ContextLinkId,
	InputRequestId,
	MessageId,
	ProviderSessionId,
	ProviderThreadId,
	ProviderTurnId,
	StepId,
	TimelineItemId,
} from "./ids.ts";
import { PermissionKind } from "./permission.ts";

/** The app-side session id. Provider processes use `ProviderSessionId`. */
const SessionId = AgentSessionId;

/**
 * Agent Engine contracts: the durable session graph.
 *
 * A session is the user-visible conversation. Inside it, a `Turn` is one
 * counted user turn, an `Attempt` is one provider execution of that turn, and
 * `Step`s form the tree of work inside an attempt (tools, approvals,
 * subagents). Provider-native conversations are `ProviderThread` handles that
 * a session accumulates over time; the live provider process is a separate,
 * replaceable `ProviderSession`.
 *
 * Rules these types encode:
 *   - App ids are identity. Provider ids are evidence, carried as `ProviderRef`.
 *   - Only the root step of the active attempt may complete a turn. A child
 *     step finishing never closes its parent.
 *   - Every provider interaction is a durable job, so a turn is never
 *     "running" on the strength of an in-memory process handle.
 *   - Provider switches, forks, merge-backs, and subagent results are all
 *     `ContextLink`s with a lazily materialised `ContextHandoff`.
 */

const NonNegativeInt = Schema.Number.check(
	Schema.isInt(),
	Schema.makeFilter((value) =>
		value >= 0 ? undefined : "Expected a non-negative integer.",
	),
);

const PositiveInt = Schema.Number.check(
	Schema.isInt(),
	Schema.makeFilter((value) =>
		value >= 1 ? undefined : "Expected a positive integer.",
	),
);

const Timestamp = Schema.DateFromString;
const NullableTimestamp = Schema.NullOr(Timestamp);

// ---------------------------------------------------------------------------
// Provider references
// ---------------------------------------------------------------------------

/**
 * How trustworthy a provider-native id is for correlation. `strong` ids are
 * stable across resume and replay; `weak` ids need an ordinal or fingerprint
 * alongside them; `none` means the app allocated the id by scoped ordinal.
 */
export const NativeRefStrength = Schema.Literals(["strong", "weak", "none"]);
export type NativeRefStrength = typeof NativeRefStrength.Type;

/**
 * A provider-native identifier kept as a reference on an app-owned entity.
 * Never used as a primary key.
 */
export const ProviderRef = Schema.Struct({
	provider: ProviderId,
	nativeId: Schema.NullOr(Schema.String),
	strength: NativeRefStrength,
	fingerprint: Schema.optional(Schema.String),
	ordinal: Schema.optional(NonNegativeInt),
});
export type ProviderRef = typeof ProviderRef.Type;

// ---------------------------------------------------------------------------
// Provider capabilities
// ---------------------------------------------------------------------------

export const ProviderSessionCapabilities = Schema.Struct({
	multipleThreadsPerSession: Schema.Boolean,
	modelSwitchInSession: Schema.Boolean,
	runtimeModeSwitchInSession: Schema.Boolean,
	pendingRequestsSurviveRestart: Schema.Boolean,
});

export const ProviderThreadCapabilities = Schema.Struct({
	createEmptyThread: Schema.Boolean,
	readSnapshot: Schema.Boolean,
	rollback: Schema.Boolean,
	rollbackReturnsSnapshot: Schema.Boolean,
	fork: Schema.Boolean,
	forkFromTurn: Schema.Boolean,
	forkFromSubagentThread: Schema.Boolean,
});

export const ProviderTurnCapabilities = Schema.Struct({
	interrupt: Schema.Boolean,
	activeSteering: Schema.Boolean,
	steeringByInterruptRestart: Schema.Boolean,
	queuedMessages: Schema.Boolean,
	terminalStatusQuality: Schema.Literals(["strong", "weak", "none"]),
});

export const ProviderStreamingCapabilities = Schema.Struct({
	assistantText: Schema.Boolean,
	reasoning: Schema.Boolean,
	toolOutput: Schema.Boolean,
	planText: Schema.Boolean,
	messageCompleted: Schema.Boolean,
});

export const ProviderApprovalCapabilities = Schema.Struct({
	commandApproval: Schema.Boolean,
	fileReadApproval: Schema.Boolean,
	fileChangeApproval: Schema.Boolean,
	nativeRequestIds: Schema.Boolean,
	callbacksAreLiveOnly: Schema.Boolean,
	fromSubagents: Schema.Boolean,
});

export const ProviderPlanningCapabilities = Schema.Struct({
	todoList: Schema.Boolean,
	proposedPlan: Schema.Boolean,
	structuredQuestions: Schema.Boolean,
});

export const ProviderSubagentCapabilities = Schema.Struct({
	native: Schema.Boolean,
	exposesThreadIds: Schema.Boolean,
	lifecycleEvents: Schema.Boolean,
	wait: Schema.Boolean,
	close: Schema.Boolean,
	forkThread: Schema.Boolean,
});

export const ProviderContextCapabilities = Schema.Struct({
	acceptsSystemContext: Schema.Boolean,
	acceptsSyntheticUserContext: Schema.Boolean,
	consumesHandoffSummaries: Schema.Boolean,
	deltaHandoff: Schema.Boolean,
	fullHandoff: Schema.Boolean,
	maxRecommendedHandoffChars: Schema.NullOr(PositiveInt),
});

export const ProviderIdentityCapabilities = Schema.Struct({
	threadIds: NativeRefStrength,
	turnIds: NativeRefStrength,
	itemIds: NativeRefStrength,
	requestIds: NativeRefStrength,
});

/**
 * Declared by every provider driver when a provider session opens and stored
 * on the `ProviderSession` row. The engine branches on these flags through
 * one policy module and never on `ProviderId`.
 */
export const ProviderCapabilities = Schema.Struct({
	session: ProviderSessionCapabilities,
	thread: ProviderThreadCapabilities,
	turn: ProviderTurnCapabilities,
	streaming: ProviderStreamingCapabilities,
	approvals: ProviderApprovalCapabilities,
	planning: ProviderPlanningCapabilities,
	subagents: ProviderSubagentCapabilities,
	context: ProviderContextCapabilities,
	identity: ProviderIdentityCapabilities,
});
export type ProviderCapabilities = typeof ProviderCapabilities.Type;

// ---------------------------------------------------------------------------
// Turns and attempts
// ---------------------------------------------------------------------------

export const TurnStatus = Schema.Literals([
	"preparing",
	"queued",
	"starting",
	"running",
	"finalizing",
	"completed",
	"interrupted",
	"failed",
	"cancelled",
	"rolled_back",
]);
export type TurnStatus = typeof TurnStatus.Type;

/** Turn statuses that block another turn from starting on the same session. */
export const ACTIVE_TURN_STATUSES: ReadonlyArray<TurnStatus> = [
	"preparing",
	"starting",
	"running",
	"finalizing",
];

export const TERMINAL_TURN_STATUSES: ReadonlyArray<TurnStatus> = [
	"completed",
	"interrupted",
	"failed",
	"cancelled",
	"rolled_back",
];

export const isActiveTurnStatus = (status: TurnStatus): boolean =>
	ACTIVE_TURN_STATUSES.includes(status);

export const isTerminalTurnStatus = (status: TurnStatus): boolean =>
	TERMINAL_TURN_STATUSES.includes(status);

/**
 * One counted user turn. Keeps its id and ordinal across steering restarts
 * and provider switches; only the attempt changes. `finalizing` means the
 * provider finished and the post-turn checkpoint is being captured.
 */
export const Turn = Schema.Struct({
	id: AgentTurnId,
	sessionId: SessionId,
	ordinal: PositiveInt,
	provider: ProviderId,
	model: Schema.NullOr(Schema.String),
	providerThreadId: Schema.NullOr(ProviderThreadId),
	userMessageId: MessageId,
	rootStepId: Schema.NullOr(StepId),
	activeAttemptId: Schema.NullOr(AttemptId),
	status: TurnStatus,
	queuePosition: Schema.NullOr(PositiveInt),
	requestedAt: Timestamp,
	startedAt: NullableTimestamp,
	completedAt: NullableTimestamp,
	checkpointId: Schema.NullOr(CheckpointId),
	contextHandoffId: Schema.NullOr(ContextHandoffId),
});
export type Turn = typeof Turn.Type;

export const AttemptReason = Schema.Literals([
	"initial",
	"steering_restart",
	"retry",
	"provider_recovery",
]);
export type AttemptReason = typeof AttemptReason.Type;

export const AttemptStatus = Schema.Literals([
	"pending",
	"running",
	"completed",
	"interrupted",
	"failed",
	"cancelled",
	"superseded",
]);
export type AttemptStatus = typeof AttemptStatus.Type;

/**
 * One provider execution of a turn. Most turns have one attempt; steering on
 * a provider without native steering, retries, and provider recovery after a
 * restart create more. Only the turn's `activeAttemptId` may complete it.
 * The lease is renewed by the fibre ingesting provider events so a dead
 * fibre or process can be detected and the attempt terminalised.
 */
export const Attempt = Schema.Struct({
	id: AttemptId,
	turnId: AgentTurnId,
	ordinal: PositiveInt,
	rootStepId: StepId,
	provider: ProviderId,
	providerThreadId: ProviderThreadId,
	providerTurnId: Schema.NullOr(ProviderTurnId),
	reason: AttemptReason,
	status: AttemptStatus,
	leaseOwner: Schema.NullOr(Schema.String),
	leaseExpiresAt: NullableTimestamp,
	startedAt: NullableTimestamp,
	completedAt: NullableTimestamp,
});
export type Attempt = typeof Attempt.Type;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const StepKind = Schema.Literals([
	"root",
	"assistant_message",
	"reasoning",
	"plan",
	"todo_list",
	"tool_call",
	"approval",
	"question",
	"subagent",
	"hook",
	"system",
]);
export type StepKind = typeof StepKind.Type;

export const StepStatus = Schema.Literals([
	"pending",
	"running",
	"waiting",
	"completed",
	"interrupted",
	"failed",
	"cancelled",
	"rolled_back",
]);
export type StepStatus = typeof StepStatus.Type;

/**
 * A unit of work inside an attempt. Steps nest through `parentStepId`; the
 * `rootStepId` is the attempt's root. `completesTurn` is true only for the
 * root, so a child finishing can never be mistaken for turn completion.
 */
export const Step = Schema.Struct({
	id: StepId,
	sessionId: SessionId,
	turnId: Schema.NullOr(AgentTurnId),
	parentStepId: Schema.NullOr(StepId),
	rootStepId: StepId,
	kind: StepKind,
	status: StepStatus,
	completesTurn: Schema.Boolean,
	providerThreadId: Schema.NullOr(ProviderThreadId),
	providerTurnId: Schema.NullOr(ProviderTurnId),
	nativeItemRef: Schema.NullOr(ProviderRef),
	inputRequestId: Schema.NullOr(InputRequestId),
	checkpointScopeId: Schema.NullOr(CheckpointScopeId),
	startedAt: NullableTimestamp,
	completedAt: NullableTimestamp,
});
export type Step = typeof Step.Type;

// ---------------------------------------------------------------------------
// Provider sessions, threads, and turns
// ---------------------------------------------------------------------------

export const ProviderSessionStatus = Schema.Literals([
	"starting",
	"ready",
	"running",
	"waiting",
	"stopped",
	"error",
]);
export type ProviderSessionStatus = typeof ProviderSessionStatus.Type;

/**
 * Durable metadata for a live-or-recoverable provider process. The in-memory
 * handle may vanish (restart, idle release, crash); this row and the
 * `ProviderThread` refs are what make a later resume possible. Provider
 * sessions are never resurrected at boot; a later command opens one lazily.
 */
export const ProviderSession = Schema.Struct({
	id: ProviderSessionId,
	provider: ProviderId,
	status: ProviderSessionStatus,
	cwd: Schema.String,
	model: Schema.NullOr(Schema.String),
	capabilities: ProviderCapabilities,
	createdAt: Timestamp,
	updatedAt: Timestamp,
	lastError: Schema.NullOr(Schema.String),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderThreadStatus = Schema.Literals([
	"not_loaded",
	"idle",
	"active",
	"archived",
	"closed",
	"error",
]);
export type ProviderThreadStatus = typeof ProviderThreadStatus.Type;

/** Provider-owned background work that can outlive the root turn. */
export const BackgroundTask = Schema.Struct({
	taskId: Schema.String,
	description: Schema.optional(Schema.String),
	taskType: Schema.optional(Schema.String),
});
export type BackgroundTask = typeof BackgroundTask.Type;

export const ProviderThreadForkSource = Schema.Struct({
	providerThreadId: ProviderThreadId,
	providerTurnId: Schema.optional(ProviderTurnId),
});

/**
 * A provider-native conversation handle. A session accumulates several over
 * time: one per provider it has used, plus replacements after failed resumes.
 * `firstTurnOrdinal`..`lastTurnOrdinal` and `handoffIds` describe which of
 * the session's turns this provider has actually seen natively.
 */
export const ProviderThread = Schema.Struct({
	id: ProviderThreadId,
	provider: ProviderId,
	providerSessionId: Schema.NullOr(ProviderSessionId),
	sessionId: Schema.NullOr(SessionId),
	ownerStepId: Schema.NullOr(StepId),
	nativeThreadRef: Schema.NullOr(ProviderRef),
	nativeHeadRef: Schema.NullOr(ProviderRef),
	status: ProviderThreadStatus,
	firstTurnOrdinal: Schema.NullOr(PositiveInt),
	lastTurnOrdinal: Schema.NullOr(PositiveInt),
	handoffIds: Schema.Array(ContextHandoffId),
	forkedFrom: Schema.NullOr(ProviderThreadForkSource),
	backgroundTasks: Schema.Array(BackgroundTask),
	createdAt: Timestamp,
	updatedAt: Timestamp,
});
export type ProviderThread = typeof ProviderThread.Type;

export const ProviderTurnStatus = Schema.Literals([
	"pending",
	"running",
	"completed",
	"interrupted",
	"failed",
	"cancelled",
]);
export type ProviderTurnStatus = typeof ProviderTurnStatus.Type;

export const ProviderTurnTokenUsage = Schema.Struct({
	usedTokens: NonNegativeInt,
	maxTokens: Schema.optional(PositiveInt),
	inputTokens: Schema.optional(NonNegativeInt),
	cachedInputTokens: Schema.optional(NonNegativeInt),
	outputTokens: Schema.optional(NonNegativeInt),
	reasoningOutputTokens: Schema.optional(NonNegativeInt),
	updatedAt: Timestamp,
});
export type ProviderTurnTokenUsage = typeof ProviderTurnTokenUsage.Type;

/**
 * The app handle for a provider-native turn. Strong-id providers map their
 * turn id into `nativeTurnRef`; weak providers get an ordinal.
 */
export const ProviderTurn = Schema.Struct({
	id: ProviderTurnId,
	providerThreadId: ProviderThreadId,
	stepId: StepId,
	attemptId: Schema.NullOr(AttemptId),
	nativeTurnRef: Schema.NullOr(ProviderRef),
	ordinal: PositiveInt,
	status: ProviderTurnStatus,
	startedAt: NullableTimestamp,
	completedAt: NullableTimestamp,
	tokenUsage: Schema.optional(ProviderTurnTokenUsage),
});
export type ProviderTurn = typeof ProviderTurn.Type;

// ---------------------------------------------------------------------------
// Input requests (approvals and questions)
// ---------------------------------------------------------------------------

export const InputRequestKind = Schema.Union([
	Schema.TaggedStruct("permission", { permission: PermissionKind }),
	Schema.TaggedStruct("question", {
		questions: Schema.Array(UserQuestion),
	}),
	Schema.TaggedStruct("plan_approval", {}),
	Schema.TaggedStruct("tool_callback", { toolName: Schema.String }),
	Schema.TaggedStruct("auth_refresh", {}),
]);
export type InputRequestKind = typeof InputRequestKind.Type;

export const InputRequestStatus = Schema.Literals([
	"pending",
	"answered",
	"expired",
	"cancelled",
]);
export type InputRequestStatus = typeof InputRequestStatus.Type;

/**
 * Whether a pending request can still be answered. The request row survives
 * restarts; the provider callback usually does not. An `expired`
 * answerability is rendered as expired instead of as a button that answers
 * into a dead process.
 */
export const InputRequestAnswerability = Schema.Union([
	Schema.TaggedStruct("live", { providerSessionId: ProviderSessionId }),
	Schema.TaggedStruct("expired", { reason: Schema.String }),
]);
export type InputRequestAnswerability = typeof InputRequestAnswerability.Type;

export const InputRequest = Schema.Struct({
	id: InputRequestId,
	sessionId: SessionId,
	stepId: StepId,
	providerTurnId: Schema.NullOr(ProviderTurnId),
	nativeRequestRef: Schema.NullOr(ProviderRef),
	kind: InputRequestKind,
	status: InputRequestStatus,
	answerability: InputRequestAnswerability,
	createdAt: Timestamp,
	answeredAt: NullableTimestamp,
});
export type InputRequest = typeof InputRequest.Type;

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

export const SubagentOrigin = Schema.Literals(["provider_native", "app_owned"]);
export type SubagentOrigin = typeof SubagentOrigin.Type;

export const SubagentStatus = Schema.Literals([
	"pending",
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);
export type SubagentStatus = typeof SubagentStatus.Type;

/**
 * `always`: wake the parent on every child terminal (async delegation).
 * `settled_only`: only when the parent has no live turn, because the result
 * returns through a blocking tool call (wait-mode delegation).
 */
export const SubagentCompletionWake = Schema.Literals([
	"always",
	"settled_only",
]);
export type SubagentCompletionWake = typeof SubagentCompletionWake.Type;

/**
 * A subagent shares its id with its `subagent` step. App-owned subagents also
 * own a child session (`childSessionId`) with lineage back to
 * `parentStepId`, so the whole timeline stack works on the child unchanged.
 */
export const Subagent = Schema.Struct({
	id: StepId,
	sessionId: SessionId,
	turnId: Schema.NullOr(AgentTurnId),
	parentStepId: StepId,
	origin: SubagentOrigin,
	provider: ProviderId,
	providerThreadId: Schema.NullOr(ProviderThreadId),
	childSessionId: Schema.NullOr(SessionId),
	nativeTaskRef: Schema.NullOr(ProviderRef),
	prompt: Schema.String,
	title: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	completionWake: Schema.optional(SubagentCompletionWake),
	status: SubagentStatus,
	progress: Schema.optional(Schema.String),
	result: Schema.NullOr(Schema.String),
	startedAt: NullableTimestamp,
	completedAt: NullableTimestamp,
	updatedAt: Timestamp,
});
export type Subagent = typeof Subagent.Type;

// ---------------------------------------------------------------------------
// Context links and handoffs
// ---------------------------------------------------------------------------

/** The exact state being carried over: prefer completed turns and checkpoints. */
export const ContextPoint = Schema.Struct({
	sessionId: SessionId,
	turnId: Schema.optional(AgentTurnId),
	checkpointId: Schema.optional(CheckpointId),
	timelineItemId: Schema.optional(TimelineItemId),
	providerThreadRef: Schema.optional(ProviderRef),
	providerTurnRef: Schema.optional(ProviderRef),
});
export type ContextPoint = typeof ContextPoint.Type;

export const ContextLinkType = Schema.Literals([
	"fork",
	"provider_switch",
	"provider_resume_fallback",
	"merge_back",
	"subagent_spawn",
	"subagent_result",
]);
export type ContextLinkType = typeof ContextLinkType.Type;

export const ContextLinkStatus = Schema.Literals([
	"pending",
	"resolved_native",
	"resolved_portable",
	"failed",
	"consumed",
	"superseded",
]);
export type ContextLinkStatus = typeof ContextLinkStatus.Type;

export const ContextLinkResolution = Schema.Union([
	Schema.TaggedStruct("native_fork", { providerThreadRef: ProviderRef }),
	Schema.TaggedStruct("handoff", { contextHandoffId: ContextHandoffId }),
]);
export type ContextLinkResolution = typeof ContextLinkResolution.Type;

/**
 * The durable relationship between a source and a target: cheap to create,
 * resolved lazily when the target turn starts and the provider is known.
 */
export const ContextLink = Schema.Struct({
	id: ContextLinkId,
	type: ContextLinkType,
	sourceSessionId: SessionId,
	targetSessionId: SessionId,
	sourcePoint: ContextPoint,
	basePoint: Schema.NullOr(ContextPoint),
	sourceProvider: Schema.NullOr(ProviderId),
	targetProvider: Schema.NullOr(ProviderId),
	status: ContextLinkStatus,
	resolution: Schema.NullOr(ContextLinkResolution),
	error: Schema.NullOr(Schema.String),
	createdBy: Schema.Literals(["user", "agent", "system"]),
	createdAt: Timestamp,
	consumedAt: NullableTimestamp,
});
export type ContextLink = typeof ContextLink.Type;

export const ContextHandoffStrategy = Schema.Literals([
	"delta_since_provider_last_seen",
	"fork_delta",
	"full_session",
	"checkpoint",
	"manual",
]);
export type ContextHandoffStrategy = typeof ContextHandoffStrategy.Type;

export const ContextHandoffStatus = Schema.Literals([
	"pending",
	"ready",
	"failed",
	"superseded",
]);
export type ContextHandoffStatus = typeof ContextHandoffStatus.Type;

/**
 * The materialised, auditable payload consumed by a turn when native
 * continuation is unavailable. It is graph data, not a hidden prompt.
 */
export const ContextHandoff = Schema.Struct({
	id: ContextHandoffId,
	linkId: Schema.NullOr(ContextLinkId),
	sessionId: SessionId,
	targetTurnId: AgentTurnId,
	fromProviderThreadIds: Schema.Array(ProviderThreadId),
	toProviderThreadId: ProviderThreadId,
	coveredTurnOrdinals: Schema.Struct({
		from: NonNegativeInt,
		to: NonNegativeInt,
	}),
	strategy: ContextHandoffStrategy,
	status: ContextHandoffStatus,
	summaryMessageId: Schema.NullOr(MessageId),
	summaryText: Schema.String,
	createdByProvider: Schema.NullOr(ProviderId),
	createdAt: Timestamp,
	updatedAt: Timestamp,
});
export type ContextHandoff = typeof ContextHandoff.Type;

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export const CheckpointScopeKind = Schema.Literals([
	"turn",
	"subagent",
	"tool",
	"provider_thread",
	"manual",
]);
export type CheckpointScopeKind = typeof CheckpointScopeKind.Type;

/**
 * A unit of filesystem state that can be checkpointed. Turn scopes advance
 * the session's turn count; nested scopes do not.
 */
export const CheckpointScope = Schema.Struct({
	id: CheckpointScopeId,
	sessionId: SessionId,
	turnId: Schema.NullOr(AgentTurnId),
	stepId: StepId,
	parentScopeId: Schema.NullOr(CheckpointScopeId),
	providerThreadId: Schema.NullOr(ProviderThreadId),
	kind: CheckpointScopeKind,
	ordinalWithinParent: NonNegativeInt,
	advancesTurnCount: Schema.Boolean,
	cwd: Schema.String,
	createdAt: Timestamp,
});
export type CheckpointScope = typeof CheckpointScope.Type;

export const CheckpointStatus = Schema.Literals([
	"ready",
	"missing",
	"error",
	"stale",
]);
export type CheckpointStatus = typeof CheckpointStatus.Type;

export const CheckpointFileSummary = Schema.Struct({
	path: Schema.String,
	status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
	additions: Schema.optional(NonNegativeInt),
	deletions: Schema.optional(NonNegativeInt),
});
export type CheckpointFileSummary = typeof CheckpointFileSummary.Type;

export const Checkpoint = Schema.Struct({
	id: CheckpointId,
	sessionId: SessionId,
	scopeId: CheckpointScopeId,
	turnId: Schema.NullOr(AgentTurnId),
	stepId: StepId,
	parentCheckpointId: Schema.NullOr(CheckpointId),
	ordinalWithinScope: NonNegativeInt,
	turnOrdinal: Schema.NullOr(NonNegativeInt),
	ref: Schema.String,
	status: CheckpointStatus,
	files: Schema.Array(CheckpointFileSummary),
	capturedAt: Timestamp,
});
export type Checkpoint = typeof Checkpoint.Type;

// ---------------------------------------------------------------------------
// Timeline items (the ordered projection clients render)
// ---------------------------------------------------------------------------

export const TimelineItemStatus = Schema.Literals([
	"pending",
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);
export type TimelineItemStatus = typeof TimelineItemStatus.Type;

/** Why a user message entered the session. Drives how the UI labels it. */
export const UserMessageIntent = Schema.Literals([
	"turn_start",
	"queued_turn",
	"steer",
	"promoted_queued_to_steer",
]);
export type UserMessageIntent = typeof UserMessageIntent.Type;

const TimelineItemBase = {
	id: TimelineItemId,
	sessionId: SessionId,
	turnId: Schema.NullOr(AgentTurnId),
	stepId: Schema.NullOr(StepId),
	providerThreadId: Schema.NullOr(ProviderThreadId),
	providerTurnId: Schema.NullOr(ProviderTurnId),
	nativeItemRef: Schema.NullOr(ProviderRef),
	parentItemId: Schema.NullOr(TimelineItemId),
	ordinal: NonNegativeInt,
	status: TimelineItemStatus,
	title: Schema.NullOr(Schema.String),
	startedAt: NullableTimestamp,
	completedAt: NullableTimestamp,
	updatedAt: Timestamp,
} as const;

/**
 * Server-owned ordered timeline rows. Clients render these directly instead
 * of merging messages, tools, approvals, and plans themselves. Every row keeps
 * refs back into the graph (`turnId`, `stepId`, `providerTurnId`,
 * `nativeItemRef`) so debug views can jump from the display stream into the
 * graph and provider logs.
 */
export const TimelineItem = Schema.Union([
	Schema.TaggedStruct("user_message", {
		...TimelineItemBase,
		messageId: MessageId,
		intent: UserMessageIntent,
		text: Schema.String,
		attachments: Schema.Array(AttachmentRef),
	}),
	Schema.TaggedStruct("assistant_message", {
		...TimelineItemBase,
		messageId: MessageId,
		text: Schema.String,
		streaming: Schema.Boolean,
	}),
	Schema.TaggedStruct("reasoning", {
		...TimelineItemBase,
		text: Schema.String,
		streaming: Schema.Boolean,
	}),
	Schema.TaggedStruct("proposed_plan", {
		...TimelineItemBase,
		markdown: Schema.String,
		streaming: Schema.Boolean,
	}),
	Schema.TaggedStruct("todo_list", {
		...TimelineItemBase,
		steps: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				text: Schema.String,
				status: Schema.Literals(["pending", "running", "completed"]),
			}),
		),
	}),
	Schema.TaggedStruct("tool_call", {
		...TimelineItemBase,
		toolName: Schema.String,
		input: Schema.Unknown,
		output: Schema.optional(Schema.Unknown),
	}),
	Schema.TaggedStruct("command", {
		...TimelineItemBase,
		input: Schema.String,
		output: Schema.optional(Schema.String),
		exitCode: Schema.optional(Schema.Number),
	}),
	Schema.TaggedStruct("file_change", {
		...TimelineItemBase,
		fileName: Schema.String,
		additions: Schema.optional(NonNegativeInt),
		deletions: Schema.optional(NonNegativeInt),
		diff: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("approval", {
		...TimelineItemBase,
		requestId: InputRequestId,
		request: InputRequestKind,
	}),
	Schema.TaggedStruct("question", {
		...TimelineItemBase,
		requestId: InputRequestId,
		questions: Schema.Array(UserQuestion),
	}),
	Schema.TaggedStruct("checkpoint", {
		...TimelineItemBase,
		checkpointId: CheckpointId,
		scopeId: CheckpointScopeId,
		files: Schema.Array(CheckpointFileSummary),
	}),
	Schema.TaggedStruct("interrupt_requested", {
		...TimelineItemBase,
		message: Schema.String,
	}),
	Schema.TaggedStruct("interrupt_result", {
		...TimelineItemBase,
		message: Schema.String,
	}),
	Schema.TaggedStruct("error", {
		...TimelineItemBase,
		message: Schema.String,
		retry: Schema.optional(
			Schema.Struct({
				attempt: PositiveInt,
				maxAttempts: Schema.NullOr(PositiveInt),
			}),
		),
	}),
	Schema.TaggedStruct("compaction", {
		...TimelineItemBase,
		summary: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("handoff", {
		...TimelineItemBase,
		contextHandoffId: ContextHandoffId,
		fromProviders: Schema.Array(ProviderId),
		toProvider: ProviderId,
		strategy: ContextHandoffStrategy,
		summary: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("fork", {
		...TimelineItemBase,
		sourcePoint: ContextPoint,
		targetSessionId: SessionId,
	}),
	Schema.TaggedStruct("subagent", {
		...TimelineItemBase,
		subagentId: StepId,
		origin: SubagentOrigin,
		provider: ProviderId,
		childSessionId: Schema.NullOr(SessionId),
		prompt: Schema.String,
		progress: Schema.optional(Schema.String),
		result: Schema.NullOr(Schema.String),
	}),
]);
export type TimelineItem = typeof TimelineItem.Type;

/**
 * Timeline ordinals are banded per turn so a late item for an earlier turn can
 * never sort after a later turn: `turnOrdinal * TIMELINE_TURN_BAND + n`. Items
 * with no turn (imported history) use band 0.
 */
export const TIMELINE_TURN_BAND = 1_000_000;

export const timelineBandLowerBound = (turnOrdinal: number | null): number =>
	(turnOrdinal ?? 0) * TIMELINE_TURN_BAND;

export const timelineBandUpperBound = (turnOrdinal: number | null): number =>
	timelineBandLowerBound(turnOrdinal) + TIMELINE_TURN_BAND - 1;
