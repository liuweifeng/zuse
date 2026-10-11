import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_MCP_SERVER_NAME } from "../mcp-gateway/index.ts";

/**
 * OpenCode plugin whose `config` hook drops every MCP server except the Zuse
 * gateway. OpenCode deep-merges every config layer (global, project,
 * `OPENCODE_CONFIG_CONTENT`, org/managed), so a layer cannot remove another
 * layer's `mcp` entries; plugins, however, receive the merged config before
 * MCP state is built and may mutate it ("Plugin can mutate config so it has
 * to be initialized before anything else" — opencode `project/bootstrap.ts`).
 * Plugin lists from all layers are unioned, so user plugins keep loading.
 * Uses the documented function-export plugin shape.
 */
const ISOLATION_PLUGIN_SOURCE = `export const ZuseMcpIsolation = async () => ({
	config: async (config) => {
		const servers = config.mcp;
		if (servers === null || typeof servers !== "object") return;
		for (const name of Object.keys(servers)) {
			if (name !== ${JSON.stringify(APP_MCP_SERVER_NAME)}) delete servers[name];
		}
	},
});
`;

let pluginUrl: Promise<string> | null = null;

/**
 * The plugin holds no secrets, so one private copy serves every session in
 * this process; it is removed when the process exits.
 */
export const opencodeMcpIsolationPluginUrl = (): Promise<string> => {
	pluginUrl ??= (async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-opencode-mcp-"));
		process.once("exit", () => {
			rmSync(directory, { recursive: true, force: true });
		});
		const file = join(directory, "zuse-mcp-isolation.mjs");
		await writeFile(file, ISOLATION_PLUGIN_SOURCE, { mode: 0o600 });
		return pathToFileURL(file).href;
	})().catch((cause: unknown) => {
		pluginUrl = null;
		throw cause;
	});
	return pluginUrl;
};
