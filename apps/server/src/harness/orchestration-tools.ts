import {
	callOrchestrationTool,
	ensureOrchestrationPermission,
	isOrchestrationToolName,
	ORCHESTRATION_MCP_TOOLS,
	type OrchestrationPermissionOptions,
	type OrchestrationToolDeps,
	READ_ONLY_ORCHESTRATION_TOOLS,
} from "@zuse/agents/drivers/orchestration-tools";
import type {
	HarnessHost,
	HarnessToolContext,
} from "@zuse/agents/harness/types";

/** The native harness uses the same schemas, handlers and approvals as MCP drivers. */
export const makeHarnessOrchestrationTools = (
	deps: OrchestrationToolDeps,
	permissions: Omit<
		OrchestrationPermissionOptions,
		"getPermissionMode" | "requestPermission"
	> & {
		readonly requestPermission: (
			context: HarnessToolContext,
		) => OrchestrationPermissionOptions["requestPermission"];
	},
): Pick<HarnessHost, "tools" | "execute"> => ({
	tools: Object.fromEntries(
		ORCHESTRATION_MCP_TOOLS.map((definition) => [
			definition.name,
			{
				description: definition.description,
				parameters: definition.inputSchema,
				category: READ_ONLY_ORCHESTRATION_TOOLS.has(definition.name)
					? ("read" as const)
					: ("delegate" as const),
			},
		]),
	),
	execute: async (name, input, context) => {
		context.signal.throwIfAborted();
		if (!isOrchestrationToolName(name))
			throw new Error("Unknown orchestration tool");
		const args =
			input !== null && typeof input === "object" && !Array.isArray(input)
				? (input as Record<string, unknown>)
				: {};
		await ensureOrchestrationPermission(name, args, {
			getRuntimeMode: permissions.getRuntimeMode,
			getPermissionMode: () =>
				context.readOnly ? "plan" : context.permissionMode,
			requestPermission: permissions.requestPermission(context),
		});
		context.signal.throwIfAborted();
		const result = await callOrchestrationTool(deps, name, args);
		const output = result.content.map((part) => part.text).join("\n");
		if (result.isError) throw new Error(output);
		return output;
	},
});
