import { Schema } from "effect";

/** The exact execution that admitted app-owned delegated work. */
export const DelegationOrigin = Schema.Struct({
	parentSessionId: Schema.String,
	parentTurnId: Schema.String,
	parentAttemptId: Schema.String,
	providerSessionId: Schema.String,
});
export type DelegationOrigin = typeof DelegationOrigin.Type;
export const SessionDelegation = Schema.Struct({
	...DelegationOrigin.fields,
	childTurnId: Schema.String,
});
export type SessionDelegation = typeof SessionDelegation.Type;
