import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { MessageId, AgentSessionId as SessionId } from "./ids.ts";

export class SessionContextError extends Schema.TaggedErrorClass<SessionContextError>()(
	"SessionContextError",
	{ message: Schema.String },
) {}

export const SessionContextLink = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literals(["merge_back", "subagent_result"]),
	sourceSessionId: SessionId,
	targetSessionId: SessionId,
	targetMessageId: MessageId,
	baseMessageId: Schema.NullOr(MessageId),
	sourceMessageId: Schema.NullOr(MessageId),
	firstTurnId: Schema.NullOr(Schema.String),
	invalidatedAt: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
});
export type SessionContextLink = typeof SessionContextLink.Type;

export const SessionMergeBackRpc = Rpc.make("session.mergeBack", {
	payload: {
		commandId: Schema.String,
		sessionId: SessionId,
		throughMessageId: Schema.optional(MessageId),
	},
	success: SessionContextLink,
	error: SessionContextError,
});
export const SessionContextLinksRpc = Rpc.make("session.contextLinks", {
	payload: { sessionId: SessionId },
	success: Schema.Array(SessionContextLink),
	error: SessionContextError,
});

export const SessionForkConstruction = Schema.Struct({
	sessionId: SessionId,
	title: Schema.String,
	state: Schema.Literals(["pending", "failed"]),
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
});
export type SessionForkConstruction = typeof SessionForkConstruction.Type;
export const SessionForkConstructionsRpc = Rpc.make(
	"session.forkConstructions",
	{
		payload: { sessionId: SessionId },
		success: Schema.Array(SessionForkConstruction),
		error: SessionContextError,
	},
);
export const SessionRetryForkRpc = Rpc.make("session.retryFork", {
	payload: { sessionId: SessionId, forkSessionId: SessionId },
	success: Schema.Void,
	error: SessionContextError,
});
export const SessionCancelForkRpc = Rpc.make("session.cancelFork", {
	payload: { sessionId: SessionId, forkSessionId: SessionId },
	success: Schema.Void,
	error: SessionContextError,
});
