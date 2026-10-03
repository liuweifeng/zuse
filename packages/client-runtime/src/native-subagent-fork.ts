import type { SessionExecutionStep } from "@zuse/contracts";

/** Reused native item IDs must never select a different attempt's child. */
export const completedNativeChildStep = (
	steps: readonly SessionExecutionStep[],
	child: { readonly itemId: string; readonly nativeChildId: string },
): SessionExecutionStep | null => {
	const matches = steps.filter(
		(step) =>
			step.kind === "subagent" &&
			step.itemId === child.itemId &&
			step.nativeChildId === child.nativeChildId,
	);
	return matches.length === 1 && matches[0]?.status === "completed"
		? matches[0]
		: null;
};
