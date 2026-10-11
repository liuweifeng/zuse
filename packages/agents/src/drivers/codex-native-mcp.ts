import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { APP_MCP_SERVER_NAME } from "../mcp-gateway/index.ts";
import type { ConfigReadResponse } from "./codex/generated/v2/ConfigReadResponse";
import type { CodexAppServerClient } from "./codex-app-server-client.ts";
import { withCodexControlClient } from "./codex-control-client.ts";

/**
 * How a Zuse Codex session hides the user's own MCP servers. Agents receive
 * MCP only through the Zuse gateway, but Codex has no switch that drops
 * native `[mcp_servers]`: `-c` overrides deep-merge into config.toml, so the
 * only lever is `enabled = false` per *existing* name (a name without a
 * transport makes the whole config invalid). Names are therefore split by
 * the layer that defines them:
 *
 * - `processServerNames`: system/user/managed layers. They load regardless of
 *   cwd, so they are safe as app-server launch overrides.
 * - `threadConfig`: trusted project layers for this cwd. Applied per thread
 *   (`thread/start|resume|fork` `config`), which Codex resolves with the
 *   same cwd. Dotted names cannot be addressed by these path keys and are
 *   reported in `unaddressableServerNames`.
 */
export interface CodexNativeMcpIsolation {
	readonly processServerNames: ReadonlyArray<string>;
	readonly threadConfig: Readonly<Record<string, false>>;
	readonly unaddressableServerNames: ReadonlyArray<string>;
	/** Loopback entries older Zuse versions wrote into the user's config. */
	readonly legacyAppOwnedServerNames: ReadonlyArray<string>;
}

export const EMPTY_CODEX_NATIVE_MCP_ISOLATION: CodexNativeMcpIsolation = {
	processServerNames: [],
	threadConfig: {},
	unaddressableServerNames: [],
	legacyAppOwnedServerNames: [],
};

const LEGACY_APP_SERVER_NAMES = new Set([
	"zuse",
	"zuse-orchestration",
	"zuse-connectors",
	"zuse-images",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasTransport = (entry: Record<string, unknown>): boolean =>
	typeof entry.command === "string" || typeof entry.url === "string";

const isLegacyAppOwnedEntry = (
	name: string,
	entry: Record<string, unknown>,
): boolean => {
	if (
		!LEGACY_APP_SERVER_NAMES.has(name) ||
		entry.bearer_token_env_var !== "ZUSE_MCP_TOKEN" ||
		typeof entry.url !== "string"
	) {
		return false;
	}
	try {
		const url = new URL(entry.url);
		const loopback =
			url.hostname === "127.0.0.1" || url.hostname === "localhost";
		return loopback && url.pathname === `/mcp/${name}`;
	} catch {
		return false;
	}
};

/** Pure classification of a `config/read { includeLayers: true, cwd }` reply. */
export const codexNativeMcpIsolation = (
	response: Pick<ConfigReadResponse, "layers">,
): CodexNativeMcpIsolation => {
	const processNames = new Set<string>();
	const projectNames = new Set<string>();
	const legacy = new Set<string>();
	for (const layer of response.layers ?? []) {
		// Disabled layers (e.g. an untrusted project) do not load, so a name
		// defined only there must not be referenced.
		if (layer.disabledReason !== null) continue;
		if (layer.name.type === "sessionFlags") continue;
		const servers = isRecord(layer.config) ? layer.config.mcp_servers : null;
		if (!isRecord(servers)) continue;
		for (const [name, entry] of Object.entries(servers)) {
			if (!isRecord(entry) || !hasTransport(entry)) continue;
			if (layer.name.type === "user" && isLegacyAppOwnedEntry(name, entry)) {
				legacy.add(name);
			}
			if (name === APP_MCP_SERVER_NAME) continue;
			(layer.name.type === "project" ? projectNames : processNames).add(name);
		}
	}
	const threadConfig: Record<string, false> = {};
	const unaddressable: string[] = [];
	for (const name of projectNames) {
		if (processNames.has(name)) continue;
		if (name.includes(".")) unaddressable.push(name);
		else threadConfig[`mcp_servers.${name}.enabled`] = false;
	}
	return {
		processServerNames: [...processNames],
		threadConfig,
		unaddressableServerNames: unaddressable,
		legacyAppOwnedServerNames: [...legacy],
	};
};

const execFileAsync = promisify(execFile);

/**
 * Removes app-owned loopback entries older Zuse versions wrote into the
 * user's Codex config (they point at a dead per-process port and break the
 * user's own Codex). Returns the names actually removed.
 */
const removeLegacyAppOwnedServers = async (
	codexPath: string | null,
	names: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv,
): Promise<ReadonlyArray<string>> => {
	const removed: string[] = [];
	for (const name of names) {
		try {
			await execFileAsync(codexPath ?? "codex", ["mcp", "remove", name], {
				env,
				timeout: 5_000,
			});
			removed.push(name);
		} catch (cause) {
			console.warn(
				`[codex] could not remove legacy app-owned MCP entry ${name}`,
				cause,
			);
		}
	}
	return removed;
};

/**
 * Reads the effective Codex config for `cwd` through the shared control
 * client and prepares the isolation overrides. Fails open: if Codex cannot
 * report its config, the session still starts (with native servers visible)
 * rather than blocking the user.
 */
export const resolveCodexNativeMcpIsolation = async (options: {
	readonly codexPath: string | null;
	readonly cwd: string;
	readonly accountHome?: string;
	readonly env: NodeJS.ProcessEnv;
}): Promise<CodexNativeMcpIsolation> => {
	let isolation: CodexNativeMcpIsolation;
	try {
		const response = await withCodexControlClient(
			options.codexPath,
			(client: CodexAppServerClient) =>
				client.request<ConfigReadResponse>("config/read", {
					includeLayers: true,
					cwd: options.cwd,
				}),
			options.accountHome,
		);
		isolation = codexNativeMcpIsolation(response);
	} catch (cause) {
		console.warn(
			"[codex] could not read native MCP config; native servers stay visible",
			cause,
		);
		return EMPTY_CODEX_NATIVE_MCP_ISOLATION;
	}
	if (isolation.unaddressableServerNames.length > 0) {
		console.warn(
			`[codex] project MCP servers with dotted names cannot be disabled: ${isolation.unaddressableServerNames.join(", ")}`,
		);
	}
	if (isolation.legacyAppOwnedServerNames.length === 0) return isolation;
	// Removed entries no longer exist, so they must not be referenced by the
	// launch overrides (an override without a transport is invalid config).
	const removed = new Set(
		await removeLegacyAppOwnedServers(
			options.codexPath,
			isolation.legacyAppOwnedServerNames,
			options.env,
		),
	);
	return {
		...isolation,
		processServerNames: isolation.processServerNames.filter(
			(name) => !removed.has(name),
		),
	};
};
