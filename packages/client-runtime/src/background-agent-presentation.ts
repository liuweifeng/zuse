import type {
	AgentTurnId,
	AttemptId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import type { ResourceView } from "./resource-state.ts";

export type RunningBackgroundTask = Readonly<{
	id: string;
	description: string;
	startedAtMs: number;
	kind: "agent" | "process";
	taskId: string;
	turnId: AgentTurnId | null;
	attemptId: AttemptId | null;
}>;

/** Background agent launches outlive a parent reply. A launch acknowledgement
 * is not completion: only the matching subagent summary settles that run.
 * Historical checkpoints cannot establish that a process is still alive. */
export const runningBackgroundTasks = (
	view: ResourceView<SessionTimelineProjection>,
): ReadonlyArray<RunningBackgroundTask> => {
	if (
		view.origin !== "runtime" ||
		view.connection !== "connected" ||
		view.data === null ||
		view.data.status === "error" ||
		view.data.status === "closed"
	)
		return [];
	const pending = new Map<string, RunningBackgroundTask>();
	const completed = new Set<string>();
	const backgroundTasks = new Set<string>();
	for (const message of view.data.messages) {
		const content = message.content;
		if (
			content._tag === "tool_use" &&
			(content.subagent?.presentation === "detached" ||
				content.backgroundTask !== undefined)
		) {
			if (content.backgroundTask !== undefined)
				backgroundTasks.add(content.itemId);
			const input = content.input;
			const description =
				input !== null &&
				typeof input === "object" &&
				"description" in input &&
				typeof input.description === "string"
					? input.description
					: "";
			if (!pending.has(content.itemId))
				pending.set(content.itemId, {
					id: content.itemId,
					description,
					startedAtMs: message.createdAt.getTime(),
					kind: content.backgroundTask === undefined ? "agent" : "process",
					taskId:
						content.backgroundTask?.taskId ??
						content.subagent?.childSessionId ??
						content.itemId,
					turnId: null,
					attemptId: null,
				});
		} else if (content._tag === "subagent_summary")
			completed.add(content.itemId);
		else if (
			content._tag === "tool_result" &&
			backgroundTasks.has(content.itemId)
		)
			completed.add(content.itemId);
	}
	const seen = new Set<string>();
	for (const step of [...(view.data.executionSteps ?? [])].sort(
		(a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
	)) {
		if (seen.has(step.itemId)) continue;
		seen.add(step.itemId);
		if (step.status !== "running") {
			completed.add(step.itemId);
		} else if (
			step.nativeChildId !== null &&
			(pending.has(step.itemId) || step.rootCompletedAt !== null)
		) {
			pending.set(step.itemId, {
				id: step.itemId,
				description: pending.get(step.itemId)?.description || step.label,
				startedAtMs: step.createdAt,
				kind: step.kind === "background" ? "process" : "agent",
				taskId: step.nativeChildId,
				turnId: step.turnId as AgentTurnId,
				attemptId: step.attemptId as AttemptId,
			});
		}
	}
	for (const id of completed) pending.delete(id);
	return [...pending.values()];
};

/** Compatibility projection for count and compact activity consumers. */
export const runningBackgroundAgents = (
	view: ResourceView<SessionTimelineProjection>,
) =>
	runningBackgroundTasks(view)
		.filter((task) => task.kind === "agent")
		.map(({ id, description, startedAtMs }) => ({
			id,
			description,
			startedAtMs,
		}));

/** Count detached agents using the same live-transcript completion rules as the task rows. */
export const countRunningBackgroundAgents = (
	view: ResourceView<SessionTimelineProjection>,
): number => runningBackgroundAgents(view).length;
