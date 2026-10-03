import type { SessionExecutionStep } from "@zuse/contracts";
import { expect, test } from "vitest";
import { completedNativeChildStep } from "../../src/native-subagent-fork.ts";

const step: SessionExecutionStep = {
	id: "step",
	turnId: "turn",
	attemptId: "attempt",
	itemId: "spawn",
	parentItemId: null,
	kind: "subagent",
	label: "Agent",
	status: "completed",
	childSessionId: "native:step",
	nativeChildId: "child-thread",
	rootCompletedAt: 1,
	createdAt: 0,
	updatedAt: 2,
	checkpointCapability: "unsupported",
};
const child = { itemId: "spawn", nativeChildId: "child-thread" };

test("only a uniquely correlated completed child can expose a fork action", () => {
	expect(completedNativeChildStep([step], child)).toBe(step);
	expect(
		completedNativeChildStep([{ ...step, status: "running" }], child),
	).toBeNull();
	expect(
		completedNativeChildStep([{ ...step, status: "cancelled" }], child),
	).toBeNull();
	expect(
		completedNativeChildStep([step], {
			...child,
			nativeChildId: "other-thread",
		}),
	).toBeNull();
	expect(
		completedNativeChildStep(
			[step, { ...step, id: "retry", attemptId: "retry", status: "running" }],
			child,
		),
	).toBeNull();
});
