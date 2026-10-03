import type { Message, SessionExecutionStep } from "@zuse/contracts";

/** Shared desktop/mobile interpretation of persisted native child completion. */
export const nativeBackgroundChildren = (
	messages: readonly Message[],
	steps: readonly SessionExecutionStep[] = [],
): ReadonlySet<string> => {
	const pending = new Set(
		steps
			.filter(
				(step) =>
					step.kind === "subagent" &&
					step.status === "running" &&
					step.rootCompletedAt !== null &&
					step.nativeChildId !== null,
			)
			.map((step) => step.nativeChildId!),
	);
	for (const { content } of messages) {
		if (content._tag === "subagent_progress" && content.rootCompleted === true)
			pending.add(content.childSessionId);
		if (
			content._tag === "subagent_summary" &&
			content.childSessionId !== undefined
		)
			pending.delete(content.childSessionId);
	}
	return pending;
};
