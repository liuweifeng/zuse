import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { ComposerInput } from "./composer.ts";
import { AgentSessionId, AgentTurnId, AttemptId, CommandId } from "./ids.ts";

export const SessionWaitTarget = Schema.Literals(["idle", "blocked", "done"]);
export const SessionWaitOptions = Schema.Struct({
	target: SessionWaitTarget,
	/** Defaults to 30 seconds; the server clamps to 1–300000 milliseconds. */
	timeoutMs: Schema.optional(Schema.Number),
});
export type SessionWaitOptions = typeof SessionWaitOptions.Type;
export const SessionWaitInput = Schema.Struct({
	sessionId: AgentSessionId,
	turnId: Schema.optional(AgentTurnId),
	attemptId: Schema.optional(AttemptId),
	...SessionWaitOptions.fields,
});
export type SessionWaitInput = typeof SessionWaitInput.Type;
export const SessionWaitResult = Schema.Struct({
	sessionId: AgentSessionId,
	turnId: Schema.NullOr(AgentTurnId),
	attemptId: Schema.NullOr(AttemptId),
	target: SessionWaitTarget,
	outcome: Schema.Literals([
		"reached",
		"timeout",
		"superseded",
		"terminal",
		"deleted",
		"no-turn",
	]),
	status: Schema.String,
});
export type SessionWaitResult = typeof SessionWaitResult.Type;
export class SessionWaitError extends Schema.TaggedErrorClass<SessionWaitError>()(
	"SessionWaitError",
	{ message: Schema.String },
) {}
export const SessionWaitRpc = Rpc.make("session.wait", {
	payload: SessionWaitInput,
	success: SessionWaitResult,
	error: SessionWaitError,
});
export const SessionSendAndWaitRpc = Rpc.make("session.sendAndWait", {
	payload: {
		commandId: CommandId,
		sessionId: AgentSessionId,
		input: ComposerInput,
		wait: SessionWaitOptions,
	},
	success: SessionWaitResult,
	error: SessionWaitError,
});
