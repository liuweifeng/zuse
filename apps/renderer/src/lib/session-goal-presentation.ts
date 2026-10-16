import type { ThreadGoal } from "@zuse/contracts";

/** One status line per goal state, shared by the composer and sidebar. */
export const GOAL_STATUS_LABEL: Record<ThreadGoal["status"], string> = {
	active: "Pursuing goal",
	paused: "Goal paused",
	budgetLimited: "Goal budget reached",
	usageLimited: "Goal usage limited",
	blocked: "Goal blocked",
	complete: "Goal complete",
};

/** Goals still in play; settled ones stop competing for the row's glyph. */
export const isGoalInProgress = (goal: ThreadGoal | null): goal is ThreadGoal =>
	goal !== null && goal.status !== "complete";
