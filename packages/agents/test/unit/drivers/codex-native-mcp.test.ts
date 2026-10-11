import { codexNativeMcpIsolation } from "@zuse/agents/drivers/codex-native-mcp";
import { describe, expect, it } from "vitest";

const layer = (
	name: Record<string, unknown>,
	servers: Record<string, unknown>,
	disabledReason: string | null = null,
) =>
	({
		name,
		version: "1",
		config: { mcp_servers: servers },
		disabledReason,
	}) as never;

describe("codexNativeMcpIsolation", () => {
	it("splits cwd-independent and project servers and skips zuse", () => {
		const isolation = codexNativeMcpIsolation({
			layers: [
				layer(
					{ type: "system", file: "/etc/codex/config.toml" },
					{ corp: { url: "https://corp.example/mcp" } },
				),
				layer(
					{ type: "user", file: "/u/.codex/config.toml" },
					{
						linear: { url: "https://mcp.linear.app/mcp" },
						zuse: { url: "https://x/mcp" },
						// An override without a transport is not a definition.
						corp: { enabled: true },
						onlyOverride: { enabled: false },
					},
				),
				layer(
					{ type: "project", dotCodexFolder: "/repo/.codex" },
					{
						local: { command: "node" },
						linear: { url: "https://mcp.linear.app/mcp" },
						"a.b": { command: "x" },
					},
				),
				layer(
					{ type: "project", dotCodexFolder: "/up/.codex" },
					{ untrusted: { command: "node" } },
					"untrusted",
				),
			],
		});
		expect(isolation.processServerNames).toEqual(["corp", "linear"]);
		expect(isolation.threadConfig).toEqual({
			"mcp_servers.local.enabled": false,
		});
		expect(isolation.unaddressableServerNames).toEqual(["a.b"]);
		expect(isolation.legacyAppOwnedServerNames).toEqual([]);
	});

	it("detects loopback entries written by older Zuse versions", () => {
		const isolation = codexNativeMcpIsolation({
			layers: [
				layer(
					{ type: "user", file: "/u/.codex/config.toml" },
					{
						"zuse-orchestration": {
							url: "http://127.0.0.1:4567/mcp/zuse-orchestration",
							bearer_token_env_var: "ZUSE_MCP_TOKEN",
						},
						"zuse-images": {
							url: "https://example.com/mcp/zuse-images",
							bearer_token_env_var: "ZUSE_MCP_TOKEN",
						},
					},
				),
			],
		});
		expect(isolation.legacyAppOwnedServerNames).toEqual(["zuse-orchestration"]);
		expect(isolation.processServerNames).toEqual([
			"zuse-orchestration",
			"zuse-images",
		]);
	});

	it("returns no overrides when Codex reports no layers", () => {
		expect(codexNativeMcpIsolation({ layers: null })).toEqual({
			processServerNames: [],
			threadConfig: {},
			unaddressableServerNames: [],
			legacyAppOwnedServerNames: [],
		});
	});
});
