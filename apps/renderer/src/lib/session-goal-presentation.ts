import type { ThreadGoal } from "@zuse/contracts";
import type { MessageKey } from "@zuse/i18n";

/** One status line per goal state, shared by the composer and sidebar. */
export const GOAL_STATUS_MESSAGE = {
	active: "chat:goal_status_active",
	paused: "chat:goal_status_paused",
	budgetLimited: "chat:goal_status_budget_limited",
	usageLimited: "chat:goal_status_usage_limited",
	blocked: "chat:goal_status_blocked",
	complete: "chat:goal_status_complete",
} as const satisfies Record<ThreadGoal["status"], MessageKey>;

/** Goals still in play; settled ones stop competing for the row's glyph. */
export const isGoalInProgress = (goal: ThreadGoal | null): goal is ThreadGoal =>
	goal !== null && goal.status !== "complete";
