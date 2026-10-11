import type { Message, SessionExecutionStep } from "@zuse/contracts";

/** Shared desktop/mobile interpretation of persisted native child completion. */
export const nativeBackgroundChildren = (
	messages: readonly Message[],
	steps: readonly SessionExecutionStep[] = [],
): ReadonlySet<string> => {
	const pending = new Set<string>();
	const nativeByItem = new Map<string, string>();
	const subagentItems = new Set<string>();
	for (const { content } of messages) {
		if (content._tag === "tool_use") {
			if (content.subagent !== undefined) subagentItems.add(content.itemId);
			const native =
				content.subagent?.childSessionId ?? content.backgroundTask?.taskId;
			if (native !== undefined) nativeByItem.set(content.itemId, native);
		}
		if (content._tag === "subagent_progress" && content.rootCompleted === true)
			pending.add(content.childSessionId);
		if (content._tag === "subagent_summary" || content._tag === "tool_result") {
			const native =
				content._tag === "subagent_summary"
					? (content.childSessionId ?? nativeByItem.get(content.itemId))
					: nativeByItem.get(content.itemId);
			// A subagent's spawn tool result is only an acknowledgement; its summary ends it.
			const isSpawnResult =
				content._tag === "tool_result" && subagentItems.has(content.itemId);
			if (native !== undefined && !isSpawnResult) pending.delete(native);
		}
	}
	// A bounded transcript may omit spawn/terminal messages. The durable latest
	// step for each native child remains authoritative after reconnect/rollback.
	const seen = new Set<string>();
	for (const step of [...steps].sort(
		(a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt,
	)) {
		if (step.nativeChildId === null || seen.has(step.nativeChildId)) continue;
		seen.add(step.nativeChildId);
		if (step.status !== "running") pending.delete(step.nativeChildId);
		else if (step.rootCompletedAt !== null) pending.add(step.nativeChildId);
	}
	return pending;
};
