import { expect, it } from "vitest";
import { makeCodexGoalLifecycle } from "../../../src/drivers/codex/goal-lifecycle.ts";

it("retains goal ownership across autonomous native turns until terminal goal evidence", () => {
	const goal = makeCodexGoalLifecycle();
	goal.start();
	goal.turnStarted();
	expect(goal.turnCompleted(false)).toBe(false);
	expect(goal.updated("active")).toBe(false);
	goal.turnStarted();
	expect(goal.updated("complete")).toBe(false);
	expect(goal.turnCompleted(false)).toBe(true);
});
it("settles paused goals between turns and failures even when native goal status remains active", () => {
	const goal = makeCodexGoalLifecycle();
	goal.start();
	expect(goal.updated("paused")).toBe(true);
	goal.start();
	goal.turnStarted();
	expect(goal.turnCompleted(true)).toBe(true);
});
it("keeps ordinary turns independent of hydrated active goals", () => {
	const goal = makeCodexGoalLifecycle();
	expect(goal.updated("active")).toBe(false);
	goal.turnStarted();
	expect(goal.turnCompleted(false)).toBe(true);
});
