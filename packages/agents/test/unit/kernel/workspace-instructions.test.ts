import { zuseWorkspaceInstructions } from "@zuse/agents/kernel/workspace-instructions";
import { describe, expect, it } from "vitest";

describe("zuseWorkspaceInstructions", () => {
	it("renders only the execution boundary and app MCP hint", () => {
		const text = zuseWorkspaceInstructions({
			projectPath: "/repo",
			cwd: "/repo/worktrees/demo",
		});

		expect(text).toContain("Project root: /repo");
		expect(text).toContain("Working directory: /repo/worktrees/demo");
		expect(text).toContain('Use the "zuse" MCP server');
		expect(text).toContain("Call emit_ui");
		expect(text).toContain("html_render");
		expect(text).toContain("Zuse's system plugins by default");
		expect(text).toContain("plugins_search");
		expect(text).toContain("Settings → Integrations");
		expect(text).not.toContain("Target base ref");
		expect(text).not.toContain("scratch");
	});
	it("keeps plugin guidance for providers without browser tools", () => {
		expect(
			zuseWorkspaceInstructions({
				projectPath: "/repo",
				cwd: "/repo",
				includeAppTools: false,
			}),
		).toContain("plugins_search");
	});
	it("does not advertise visual tools when app tools are unavailable", () => {
		const text = zuseWorkspaceInstructions({
			projectPath: "/repo",
			cwd: "/repo",
			includeAppTools: false,
		});
		expect(text).not.toContain("emit_ui");
		expect(text).not.toContain("OpenUI");
	});
});

it("only advertises orchestration when enabled and preserves shared guidance", () => {
	const options = { projectPath: "/repo", cwd: "/repo" };
	expect(zuseWorkspaceInstructions(options)).not.toContain(
		"<zuse-orchestration-tools>",
	);
	const enabled = zuseWorkspaceInstructions({
		...options,
		includeOrchestration: true,
	});
	expect(enabled).toContain("delegate_task");
	expect(enabled).toContain("Provider-native subagents");
	expect(enabled).toContain("do not run repeated status polls");
	expect(enabled).toContain("inherited permissions");
	expect(enabled).toContain("--cloud-workspace");
	expect(enabled).not.toContain("Smoke flow");
});
