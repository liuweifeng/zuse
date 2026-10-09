import {
	ORCHESTRATION_MCP_TOOLS,
	type OrchestrationToolDeps,
} from "@zuse/agents/drivers/orchestration-tools";
import type { HarnessToolContext } from "@zuse/agents/harness/types";
import { expect, it, vi } from "vitest";
import { makeHarnessOrchestrationTools } from "../../src/harness/orchestration-tools.ts";

const context = (readOnly = false): HarnessToolContext => ({
	agentId: "native-child",
	callId: "call",
	signal: new AbortController().signal,
	permissionMode: "default",
	readOnly,
});
const setup = () => {
	const delegateTask = vi.fn(async () => ({
		ok: true,
		taskId: "managed-child",
	}));
	const whoami = vi.fn(async () => ({ sessionId: "parent" }));
	const approve = vi.fn(async () => ({ _tag: "AllowOnce" as const }));
	const tools = makeHarnessOrchestrationTools(
		{ delegateTask, whoami } as unknown as OrchestrationToolDeps,
		{
			getRuntimeMode: () => "approval-required",
			requestPermission: () => approve,
		},
	);
	return { tools, delegateTask, whoami, approve };
};
it("exposes the same live tool schemas and keeps reads free of mutation approval", async () => {
	const { tools, whoami, approve } = setup();
	expect(Object.keys(tools.tools)).toEqual(
		ORCHESTRATION_MCP_TOOLS.map((tool) => tool.name),
	);
	expect(tools.tools.schedule_task?.parameters).toEqual(
		ORCHESTRATION_MCP_TOOLS.find((tool) => tool.name === "schedule_task")
			?.inputSchema,
	);
	expect(
		JSON.parse(String(await tools.execute("whoami", {}, context(true)))),
	).toEqual({ sessionId: "parent" });
	expect(whoami).toHaveBeenCalledOnce();
	expect(approve).not.toHaveBeenCalled();
});
it("uses shared approvals and denies native read-only children before delegation", async () => {
	const { tools, delegateTask, approve } = setup();
	const task = { task: "review", clientRequestId: "one" };
	await expect(
		tools.execute("delegate_task", task, context(true)),
	).rejects.toThrow("plan mode");
	expect(delegateTask).not.toHaveBeenCalled();
	expect(approve).not.toHaveBeenCalled();
	await tools.execute("delegate_task", task, context());
	expect(approve).toHaveBeenCalledOnce();
	expect(delegateTask).toHaveBeenCalledWith(task);
});
it("honors interruption before dispatching an app action", async () => {
	const { tools, delegateTask } = setup();
	const abort = new AbortController();
	abort.abort();
	await expect(
		tools.execute(
			"delegate_task",
			{ task: "review", clientRequestId: "one" },
			{ ...context(), signal: abort.signal },
		),
	).rejects.toThrow();
	expect(delegateTask).not.toHaveBeenCalled();
});
