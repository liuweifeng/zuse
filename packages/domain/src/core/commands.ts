import {
	ProviderTurnReference,
	TurnSettlementOutcome,
	type TurnSettlementOutcome as TurnSettlementOutcomeType,
} from "@zuse/contracts";
import { Schema } from "effect";
import { ProviderThreadSeed, SessionCreatedFields } from "./session-fields.js";

export const AttemptProviderTurnFields = {
	turnId: Schema.String,
	attemptId: Schema.String,
	reference: ProviderTurnReference,
	boundAt: Schema.Number,
};

export const SegmentKind = Schema.Literals(["assistant", "reasoning", "tool"]);
export type SegmentKind = typeof SegmentKind.Type;

/** Domain alias retained for callers; the wire contract is the source of truth. */
export const SettlementOutcome = TurnSettlementOutcome;
export type SettlementOutcome = TurnSettlementOutcomeType;

export const AttemptReason = Schema.Literals([
	"initial",
	"retry",
	"provider_recovery",
]);
export type AttemptReason = typeof AttemptReason.Type;

export const TurnPhase = Schema.Literals([
	"running",
	"interrupt-requested",
	"interrupt-acknowledged",
]);
export type TurnPhase = typeof TurnPhase.Type;

export const SessionCommand = Schema.Union([
	Schema.TaggedStruct("CreateSession", {
		...SessionCreatedFields,
		providerStartJson: Schema.optional(Schema.String),
		providerThread: Schema.optional(ProviderThreadSeed),
	}),
	Schema.TaggedStruct("CreateSessionWithInitialTurn", {
		...SessionCreatedFields,
		/** Legacy startup options retained on the turn, never an eager-start signal. */
		providerStartJson: Schema.optional(Schema.String),
		providerThread: Schema.optional(ProviderThreadSeed),
		turnId: Schema.String,
		messageId: Schema.String,
		messageContentJson: Schema.String,
		providerInputJson: Schema.String,
	}),
	Schema.TaggedStruct("SetTitle", {
		title: Schema.String,
		titleProvenance: SessionCreatedFields.titleProvenance,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetModel", {
		model: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetProvider", {
		providerId: Schema.String,
		model: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetRuntimeMode", {
		runtimeMode: SessionCreatedFields.runtimeMode,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetPermissionMode", {
		permissionMode: SessionCreatedFields.permissionMode,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetWorktree", {
		worktreeId: SessionCreatedFields.worktreeId,
		updatedAt: Schema.Number,
		/** Re-emit the projection when an external FK cascade drifted from state. */
		forceProjection: Schema.optional(Schema.Boolean),
	}),
	Schema.TaggedStruct("SetStatus", {
		status: SessionCreatedFields.status,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SetQueuePaused", {
		paused: Schema.Boolean,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ReleaseInitialTurn", {
		expectedTurnId: Schema.String,
		providerInputJson: Schema.String,
		providerStartJson: Schema.optional(Schema.String),
		requestedAt: Schema.Number,
	}),
	/**
	 * Bind the provider-native thread the driver reported as the session's
	 * active provider thread. Idempotent for the same native id and head.
	 */
	Schema.TaggedStruct("BindAttemptProviderTurn", AttemptProviderTurnFields),
	Schema.TaggedStruct("BindProviderThread", {
		nativeThreadId: Schema.String,
		nativeHeadId: Schema.optional(Schema.NullOr(Schema.String)),
		updatedAt: Schema.Number,
	}),
	/** Inspect a proven native execution in a fresh attempt, without resending. */
	Schema.TaggedStruct("RecoverTurn", {
		turnId: Schema.String,
		expectedAttemptId: Schema.String,
		requestedAt: Schema.Number,
	}),
	/** Intentional delivery retry. Historical recovery callers used this path. */
	Schema.TaggedStruct("RetryTurn", {
		turnId: Schema.String,
		reason: Schema.Literals(["retry", "provider_recovery"]),
		providerInputJson: Schema.String,
		providerStartJson: Schema.optional(Schema.String),
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ArchiveSession", { archivedAt: Schema.Number }),
	Schema.TaggedStruct("UnarchiveSession", { unarchivedAt: Schema.Number }),
	Schema.TaggedStruct("DeleteSession", { deletedAt: Schema.Number }),
	Schema.TaggedStruct("StartTurn", {
		turnId: Schema.String,
		startedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SubmitTurn", {
		turnId: Schema.String,
		messageId: Schema.String,
		role: Schema.String,
		kind: Schema.String,
		contentJson: Schema.String,
		parentItemId: Schema.NullOr(Schema.String),
		providerInputJson: Schema.String,
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("SettleTurn", {
		turnId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("RequestTurnInterrupt", {
		expectedTurnId: Schema.optional(Schema.String),
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("AcknowledgeTurnInterrupt", {
		turnId: Schema.String,
		acknowledgedAt: Schema.Number,
	}),
	Schema.TaggedStruct("FailTurnInterrupt", {
		turnId: Schema.String,
		reason: Schema.String,
		failedAt: Schema.Number,
	}),
	Schema.TaggedStruct("EnqueueTurn", {
		queueId: Schema.String,
		inputJson: Schema.String,
		position: Schema.Number,
		createdAt: Schema.Number,
		ready: Schema.Boolean,
	}),
	Schema.TaggedStruct("UpdateQueuedTurn", {
		queueId: Schema.String,
		inputJson: Schema.String,
		updatedAt: Schema.Number,
		ready: Schema.Boolean,
	}),
	Schema.TaggedStruct("ClaimQueuedTurn", {
		queueId: Schema.String,
		claimedAt: Schema.Number,
	}),
	Schema.TaggedStruct("RemoveQueuedTurn", {
		queueId: Schema.String,
		removedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ReorderQueuedTurns", {
		queueIds: Schema.Array(Schema.String),
		reorderedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SteerQueuedTurn", {
		expectedTurnId: Schema.String,
		queueId: Schema.String,
		successorTurnId: Schema.String,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("PersistMessage", {
		messageId: Schema.String,
		turnId: Schema.NullOr(Schema.String),
		role: Schema.String,
		kind: Schema.String,
		contentJson: Schema.String,
		parentItemId: Schema.NullOr(Schema.String),
		checkpointRevision: Schema.optional(Schema.Number),
		checkpointFinal: Schema.optional(Schema.Boolean),
		createdAt: Schema.Number,
	}),
	Schema.TaggedStruct("OpenSegment", {
		turnId: Schema.String,
		segmentId: Schema.String,
		kind: SegmentKind,
		openedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SettleSegment", {
		turnId: Schema.String,
		segmentId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("RequestPermission", {
		requestId: Schema.String,
		turnId: Schema.String,
		payloadJson: Schema.String,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ResolvePermission", {
		requestId: Schema.String,
		decision: Schema.String,
		decisionJson: Schema.optional(Schema.String),
		resolvedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ResolveQuestion", {
		itemId: Schema.String,
		resolution: Schema.Literal("cancelled"),
		resolvedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ReserveProviderSession", {
		ownerAttempt: Schema.optional(
			Schema.Struct({ turnId: Schema.String, attemptId: Schema.String }),
		),
		expectedModel: Schema.optional(Schema.String),
		expectedWorktreeId: Schema.optional(Schema.NullOr(Schema.String)),
		providerId: Schema.String,
		providerSessionId: Schema.String,
		reservedAt: Schema.Number,
	}),
	Schema.TaggedStruct("AttachProvider", {
		providerId: Schema.String,
		providerSessionId: Schema.optional(Schema.String),
		attachedAt: Schema.Number,
	}),
	Schema.TaggedStruct("RequestProviderStop", { requestedAt: Schema.Number }),
	Schema.TaggedStruct("DetachProvider", {
		detachedAt: Schema.Number,
		expectedProviderSessionId: Schema.optional(Schema.NullOr(Schema.String)),
	}),
]);
export type SessionCommand = typeof SessionCommand.Type;
