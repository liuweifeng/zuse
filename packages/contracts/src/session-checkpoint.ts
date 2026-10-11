import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { AgentTurnId, AgentSessionId as SessionId } from "./ids.ts";

/** Provider-native history boundary; a verified ordered prefix, never a rollback count. */
export const NativeHistoryCheckpoint = Schema.Struct({
	providerId: Schema.String,
	nativeThreadId: Schema.String,
	turnIds: Schema.Array(Schema.String),
});
export type NativeHistoryCheckpoint = typeof NativeHistoryCheckpoint.Type;

export class SessionCheckpointError extends Schema.TaggedErrorClass<SessionCheckpointError>()(
	"SessionCheckpointError",
	{ message: Schema.String },
) {}
export const SessionCheckpointSummary = Schema.Struct({
	id: Schema.String,
	turnId: AgentTurnId,
	turnOrdinal: Schema.Number,
	scopeId: Schema.String,
	rootStepId: Schema.NullOr(Schema.String),
	rollbackCapability: Schema.Literal("turn_boundary"),
	phase: Schema.Literals(["baseline", "final"]),
	status: Schema.Literals([
		"capturing",
		"ready",
		"error",
		"stale",
		"unsupported",
	]),
	capturedAt: Schema.NullOr(Schema.Number),
	error: Schema.NullOr(Schema.String),
	restoreId: Schema.NullOr(Schema.String),
});
export type SessionCheckpointSummary = typeof SessionCheckpointSummary.Type;
export const SessionCheckpointsListRpc = Rpc.make("session.checkpoints.list", {
	payload: { sessionId: SessionId },
	success: Schema.Array(SessionCheckpointSummary),
	error: SessionCheckpointError,
});
export const SessionCheckpointPreviewRpc = Rpc.make(
	"session.checkpoints.preview",
	{
		payload: { sessionId: SessionId, checkpointId: Schema.String },
		success: Schema.Struct({
			previewId: Schema.String,
			files: Schema.Array(Schema.String),
			expiresAt: Schema.Number,
		}),
		error: SessionCheckpointError,
	},
);
export const SessionCheckpointRestoreRpc = Rpc.make(
	"session.checkpoints.restore",
	{
		payload: { sessionId: SessionId, previewId: Schema.String },
		success: Schema.Void,
		error: SessionCheckpointError,
	},
);
export const SessionCheckpointRetryRpc = Rpc.make("session.checkpoints.retry", {
	payload: { sessionId: SessionId },
	success: Schema.Void,
	error: SessionCheckpointError,
});
