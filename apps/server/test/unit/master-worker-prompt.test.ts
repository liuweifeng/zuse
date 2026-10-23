import { afterEach, describe, expect, it, vi } from "vitest";
import { masterWorkerPrompt } from "../../src/master/state.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Zot worker instructions", () => {
	it("use the MCP tools, since packaged builds ship no zuse CLI", () => {
		vi.stubEnv("ZUSE_AGENT_CLI_COMMAND", "");
		const prompt = masterWorkerPrompt("Fix the flaky test.", "worker-1");
		expect(prompt.startsWith("Fix the flaky test.\n\n")).toBe(true);
		expect(prompt).toContain("master_state tool");
		expect(prompt).toContain("master_action tool");
		expect(prompt).not.toContain("master state --session");
	});

	it("also name the CLI when this runtime provides one", () => {
		vi.stubEnv("ZUSE_AGENT_CLI_COMMAND", "bun cli.ts");
		expect(masterWorkerPrompt("Task", "worker-1")).toContain(
			"bun cli.ts master state --session worker-1",
		);
	});
});
