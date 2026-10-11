import { opencodeMcpIsolationPluginUrl } from "@zuse/agents/drivers/opencode-mcp-isolation";
import { describe, expect, it } from "vitest";

describe("OpenCode MCP isolation plugin", () => {
	it("keeps only the Zuse gateway in the merged MCP config", async () => {
		const url = await opencodeMcpIsolationPluginUrl();
		expect(await opencodeMcpIsolationPluginUrl()).toBe(url);
		const module = (await import(url)) as Record<string, unknown>;
		// OpenCode's legacy loader requires every export to be a plugin fn.
		expect(Object.values(module).every((v) => typeof v === "function")).toBe(
			true,
		);
		const plugin = module.ZuseMcpIsolation as () => Promise<{
			config: (config: Record<string, unknown>) => Promise<void>;
		}>;
		const hooks = await plugin();
		const config = {
			mcp: {
				zuse: { type: "remote", url: "http://127.0.0.1:1/mcp" },
				linear: { type: "remote", url: "https://mcp.linear.app/mcp" },
				local: { type: "local", command: ["node", "server.js"] },
			},
		};
		await hooks.config(config);
		expect(Object.keys(config.mcp)).toEqual(["zuse"]);
	});
});
