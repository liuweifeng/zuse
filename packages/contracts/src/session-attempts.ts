import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { AgentSessionId, AgentTurnId, AttemptId } from "./ids.ts";

export const SessionAttemptCursor = Schema.Struct({
	turnOrdinal: Schema.Number,
	attemptOrdinal: Schema.Number,
});
export type SessionAttemptCursor = typeof SessionAttemptCursor.Type;
export const SessionAttemptSummary = Schema.Struct({
	id: AttemptId,
	turnId: AgentTurnId,
	turnOrdinal: Schema.Number,
	ordinal: Schema.Number,
	reason: Schema.Literals(["initial", "retry", "provider_recovery"]),
	status: Schema.Literals([
		"running",
		"completed",
		"interrupted",
		"failed",
		"superseded",
	]),
	startedAt: Schema.Number,
	completedAt: Schema.NullOr(Schema.Number),
	rolledBack: Schema.Boolean,
});
export type SessionAttemptSummary = typeof SessionAttemptSummary.Type;
export const SessionAttemptHistoryPage = Schema.Struct({
	items: Schema.Array(SessionAttemptSummary),
	nextCursor: Schema.NullOr(SessionAttemptCursor),
});
export type SessionAttemptHistoryPage = typeof SessionAttemptHistoryPage.Type;
export class SessionAttemptHistoryError extends Schema.TaggedErrorClass<SessionAttemptHistoryError>()(
	"SessionAttemptHistoryError",
	{ message: Schema.String },
) {}
export const SessionAttemptHistoryRpc = Rpc.make("session.attempts.list", {
	payload: {
		sessionId: AgentSessionId,
		before: Schema.optional(SessionAttemptCursor),
	},
	success: SessionAttemptHistoryPage,
	error: SessionAttemptHistoryError,
});
