import { Schema } from "effect";
import { InputRequestOwner } from "../agent-engine/input-owner.js";

import {
	AttemptProviderTurnFields,
	AttemptReason,
	SegmentKind,
	SettlementOutcome,
} from "./commands.js";
import {
	SessionConfigurationFields,
	SessionCreatedEventFields,
} from "./session-fields.js";

export const ProviderThreadSnapshot = Schema.Struct({
	id: Schema.String,
	provider: Schema.String,
	nativeThreadId: Schema.String,
	nativeHeadId: Schema.NullOr(Schema.String),
	status: Schema.Literals(["not_loaded", "idle", "active", "closed", "error"]),
	firstTurnOrdinal: Schema.NullOr(Schema.Number),
	lastTurnOrdinal: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
});
export type ProviderThreadSnapshot = typeof ProviderThreadSnapshot.Type;

export const SessionEvent = Schema.Union([
	Schema.TaggedStruct("SessionCreated", {
		...SessionCreatedEventFields,
		providerStartJson: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("SessionTitleSet", {
		title: Schema.String,
		titleProvenance: SessionConfigurationFields.titleProvenance,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionModelSet", {
		model: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionProviderSet", {
		providerId: Schema.String,
		model: Schema.String,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionRuntimeModeSet", {
		runtimeMode: SessionConfigurationFields.runtimeMode,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionPermissionModeSet", {
		permissionMode: SessionConfigurationFields.permissionMode,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionWorktreeSet", {
		worktreeId: SessionConfigurationFields.worktreeId,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionStatusSet", {
		status: SessionConfigurationFields.status,
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionQueuePausedSet", {
		paused: Schema.Boolean,
		updatedAt: Schema.Number,
	}),
	/** Legacy resume token; folded into a provider thread on replay. */
	Schema.TaggedStruct("SessionResumeSet", {
		cursor: Schema.NullOr(Schema.String),
		resumeStrategy: SessionConfigurationFields.resumeStrategy,
		providerEventCursor: Schema.optional(Schema.NullOr(Schema.String)),
		updatedAt: Schema.Number,
	}),
	/** Snapshot of a provider-native thread this session owns. */
	Schema.TaggedStruct("ProviderThreadUpdated", {
		providerThread: ProviderThreadSnapshot,
	}),
	Schema.TaggedStruct("ActiveProviderThreadSet", {
		providerThreadId: Schema.NullOr(Schema.String),
		updatedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SessionArchived", { archivedAt: Schema.Number }),
	Schema.TaggedStruct("SessionUnarchived", { unarchivedAt: Schema.Number }),
	Schema.TaggedStruct("SessionDeleted", { deletedAt: Schema.Number }),
	Schema.TaggedStruct("TurnStarted", {
		turnId: Schema.String,
		startedAt: Schema.Number,
		/** Counted position of the turn; derived on replay when absent. */
		ordinal: Schema.optional(Schema.Number),
		attemptId: Schema.optional(Schema.String),
		providerThreadId: Schema.optional(Schema.NullOr(Schema.String)),
	}),
	/** A retry or recovery replaced the active attempt of a turn. */
	Schema.TaggedStruct("AttemptProviderTurnBound", AttemptProviderTurnFields),
	Schema.TaggedStruct("AttemptStarted", {
		turnId: Schema.String,
		attemptId: Schema.String,
		ordinal: Schema.Number,
		reason: AttemptReason,
		startedAt: Schema.Number,
		/** Turn facts denormalised so a projection can render without state. */
		turnOrdinal: Schema.Number,
		providerThreadId: Schema.NullOr(Schema.String),
		turnRequestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderRecoveryRequested", {
		turnId: Schema.String,
		attemptId: Schema.String,
		sourceAttemptId: Schema.String,
		reference: AttemptProviderTurnFields.reference,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderTurnRequested", {
		turnId: Schema.String,
		/** Absent only on historical requests written before attempt ownership. */
		attemptId: Schema.optional(Schema.String),
		providerInputJson: Schema.String,
		/** Optional provider startup configuration for an atomic initial turn. */
		providerStartJson: Schema.optional(Schema.String),
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("TurnSettled", {
		turnId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("TurnInterruptRequested", {
		turnId: Schema.String,
		/** Absent only on historical requests written before attempt ownership. */
		attemptId: Schema.optional(Schema.String),
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("TurnInterruptAcknowledged", {
		turnId: Schema.String,
		acknowledgedAt: Schema.Number,
	}),
	Schema.TaggedStruct("TurnInterruptFailed", {
		turnId: Schema.String,
		reason: Schema.String,
		failedAt: Schema.Number,
	}),
	Schema.TaggedStruct("QueuedTurnEnqueued", {
		queueId: Schema.String,
		inputJson: Schema.String,
		position: Schema.Number,
		createdAt: Schema.Number,
		ready: Schema.Boolean,
	}),
	Schema.TaggedStruct("QueuedTurnUpdated", {
		queueId: Schema.String,
		inputJson: Schema.String,
		updatedAt: Schema.Number,
		ready: Schema.Boolean,
	}),
	Schema.TaggedStruct("QueuedTurnRemoved", {
		queueId: Schema.String,
		removedAt: Schema.Number,
	}),
	Schema.TaggedStruct("QueuedTurnsReordered", {
		queueIds: Schema.Array(Schema.String),
		reorderedAt: Schema.Number,
	}),
	Schema.TaggedStruct("QueuedTurnClaimed", {
		queueId: Schema.String,
		claimedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SuccessorTurnScheduled", {
		predecessorTurnId: Schema.String,
		turnId: Schema.String,
		queueId: Schema.String,
		inputJson: Schema.String,
		scheduledAt: Schema.Number,
	}),
	Schema.TaggedStruct("ScheduledSuccessorReady", {
		predecessorTurnId: Schema.String,
		turnId: Schema.String,
		queueId: Schema.String,
		inputJson: Schema.String,
		readyAt: Schema.Number,
	}),
	Schema.TaggedStruct("MessagePersisted", {
		inputOwner: Schema.optional(InputRequestOwner),
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
	Schema.TaggedStruct("SegmentOpened", {
		turnId: Schema.String,
		segmentId: Schema.String,
		kind: SegmentKind,
		openedAt: Schema.Number,
	}),
	Schema.TaggedStruct("SegmentSettled", {
		turnId: Schema.String,
		segmentId: Schema.String,
		outcome: SettlementOutcome,
		settledAt: Schema.Number,
	}),
	Schema.TaggedStruct("PermissionRequested", {
		inputOwner: Schema.optional(InputRequestOwner),
		requestId: Schema.String,
		turnId: Schema.String,
		payloadJson: Schema.String,
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("PermissionResolved", {
		requestId: Schema.String,
		decision: Schema.String,
		decisionJson: Schema.optional(Schema.String),
		resolvedAt: Schema.Number,
	}),
	Schema.TaggedStruct("PermissionExpired", {
		requestId: Schema.String,
		expiredAt: Schema.Number,
	}),
	Schema.TaggedStruct("QuestionResolved", {
		itemId: Schema.String,
		resolution: Schema.Literal("cancelled"),
		resolvedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderSessionReserved", {
		providerId: Schema.String,
		providerSessionId: Schema.String,
		reservedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderAttached", {
		providerId: Schema.String,
		providerSessionId: Schema.optional(Schema.String),
		attachedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderStopRequested", {
		providerId: Schema.String,
		providerSessionId: Schema.optional(Schema.String),
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("ProviderDetached", {
		providerId: Schema.String,
		providerSessionId: Schema.optional(Schema.String),
		detachedAt: Schema.Number,
	}),
]);
export type SessionEvent = typeof SessionEvent.Type;
