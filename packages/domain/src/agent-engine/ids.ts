import {
	AttemptId,
	CheckpointScopeId,
	type ProviderId,
	ProviderThreadId,
	StepId,
} from "@zuse/contracts";

const encode = (part: string | number): string =>
	encodeURIComponent(String(part));

/** Joins id parts with `:` after percent-encoding each part. */
export const joinId = (...parts: ReadonlyArray<string | number>): string =>
	parts.map(encode).join(":");

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
} as const;
