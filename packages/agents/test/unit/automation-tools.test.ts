import { expect, it } from "vitest";
import {
	AUTOMATION_TOOL_DEFINITIONS,
	type AutomationToolDependencies,
	callAutomationTool,
} from "../../src/drivers/automation-tools.ts";

const dependencies = (calls: unknown[]): AutomationToolDependencies => ({
	create: async (input) => {
		calls.push(input);
		return { id: "task" };
	},
	list: async () => [],
	update: async () => ({}),
	remove: async () => ({}),
	trigger: async () => ({}),
	requestSecret: async (input) => {
		calls.push(input);
		return { id: "request", status: "pending", reference: null };
	},
	listSecrets: async () => [],
});
it("validates recurring interval before calling the backend", async () => {
	const calls: unknown[] = [];
	const result = await callAutomationTool(
		dependencies(calls),
		"schedule_task",
		{
			clientRequestId: "one",
			title: "Check",
			prompt: "Check",
			schedule: { kind: "interval", everyMs: 1 },
		},
	);
	expect(result).toHaveProperty("isError", true);
	expect(calls).toEqual([]);
});
it("private requests carry metadata and errors cannot echo credential backend failures", async () => {
	const calls: unknown[] = [];
	const deps = dependencies(calls);
	const input = {
		clientRequestId: "one",
		label: "Token",
		reason: "Upload",
		environmentVariable: "UPLOAD_TOKEN",
	};
	const result = await callAutomationTool(deps, "request_secret", input);
	expect(calls).toEqual([input]);
	expect(result.content[0]?.text).toContain('"status":"pending"');
	const failed = await callAutomationTool(
		{
			...deps,
			requestSecret: async () => {
				throw new Error("private-token-in-backend-error");
			},
		},
		"request_secret",
		input,
	);
	expect(failed).toHaveProperty("isError", true);
	expect(JSON.stringify(failed)).not.toContain(
		"private-token-in-backend-error",
	);
});
it("publishes distinct tool schemas and reports unavailable runtimes", async () => {
	expect(
		new Set(AUTOMATION_TOOL_DEFINITIONS.map((tool) => tool.name)).size,
	).toBe(AUTOMATION_TOOL_DEFINITIONS.length);
	expect(
		await callAutomationTool(undefined, "list_scheduled_tasks", {}),
	).toHaveProperty("isError", true);
});
