import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import {
	connectLocalEngine,
	type DesktopEngineConfig,
	type DesktopEngineEndpoint,
	type EngineChannel,
	readEngineEndpoint,
	requestIdleEngineShutdown,
	writeDesktopEngineConfig,
} from "@zusehq/server/desktop-engine";
import { Schema } from "effect";

import { readEngineBuildId } from "./engine-build-id.ts";

export { readEngineBuildId } from "./engine-build-id.ts";

// A desktop process keeps its loaded build identity across renderer and host reconnects.
const builds = new Map<string, Promise<string>>();
const desktopBuildId = (path: string): Promise<string> => {
	let build = builds.get(path);
	if (build === undefined) {
		build = readEngineBuildId(path).catch((error) => {
			builds.delete(path);
			throw error;
		});
		builds.set(path, build);
	}
	return build;
};

const retainedEngines = new Set<string>();
const decodeProtocol = Schema.decodeUnknownSync(
	Schema.Struct({ protocolVersion: Schema.Number }),
);

// Existing engines already expose this endpoint, including on authenticated
// installations (401 includes the protocol). No credential is sent over HTTP.
const canAttachRebuiltDesktop = async (
	endpoint: DesktopEngineEndpoint,
	signal?: AbortSignal,
): Promise<boolean> => {
	const timeout = AbortSignal.timeout(2_000);
	try {
		const response = await fetch(
			`http://127.0.0.1:${endpoint.apiPort}/auth/cli-session`,
			{
				signal:
					signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
				redirect: "error",
			},
		);
		if (response.status !== 200 && response.status !== 401) return false;
		return (
			decodeProtocol(await response.json()).protocolVersion ===
			WIRE_PROTOCOL_VERSION
		);
	} catch {
		signal?.throwIfAborted();
		return false;
	}
};

/** Start once or attach to the existing owner. Closing the desktop never stops this process. */
export const ensureDesktopEngine = async (options: {
	readonly config: DesktopEngineConfig;
	readonly supervisorPath: string;
	readonly executable?: string;
	readonly signal?: AbortSignal;
	readonly startupTimeoutMs?: number;
}): Promise<DesktopEngineEndpoint> => {
	const { signal } = options;
	signal?.throwIfAborted();
	const config = {
		...options.config,
		buildId:
			options.config.buildId ?? (await desktopBuildId(options.supervisorPath)),
	};
	signal?.throwIfAborted();
	const probe = async () => {
		const endpoint = await readEngineEndpoint(config.userData);
		if (endpoint === null) return null;
		let channel: EngineChannel;
		try {
			channel = await connectLocalEngine(endpoint, {
				receive: () => {},
				signal,
			});
		} catch {
			signal?.throwIfAborted();
			return null;
		}
		channel.close();
		await channel.closed;
		if (
			endpoint.appVersion !== config.appVersion ||
			endpoint.buildId !== config.buildId
		) {
			const retainedKey = `${endpoint.token}:${config.appVersion}:${config.buildId}`;
			if (retainedEngines.has(retainedKey)) return endpoint;
			const stopped = await requestIdleEngineShutdown(endpoint, {
				userData: config.userData,
				signal,
			});
			if (stopped === "stopped") return null;
			// A build hash identifies executable contents, not RPC compatibility.
			// Keep active work reachable across same-release rebuilds. Once adopted,
			// reconnects keep this owner until the desktop itself restarts.
			if (
				endpoint.appVersion === config.appVersion &&
				(await canAttachRebuiltDesktop(endpoint, signal))
			) {
				retainedEngines.add(retainedKey);
				return endpoint;
			}
			throw new Error(
				"A different engine version is still running. Finish its active work before restarting the engine.",
			);
		}
		return endpoint;
	};
	const existing = await probe();
	if (existing !== null) return existing;
	const path = await writeDesktopEngineConfig(config);
	signal?.throwIfAborted();
	const child = spawn(
		options.executable ?? process.execPath,
		[options.supervisorPath, path],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		},
	);
	let spawnFailed = false;
	let exitCode: number | null = null;
	child.once("error", () => {
		spawnFailed = true;
	});
	child.once("exit", (code) => {
		exitCode = code;
	});
	child.unref();
	const deadline = performance.now() + (options.startupTimeoutMs ?? 30_000);
	while (performance.now() < deadline) {
		signal?.throwIfAborted();
		const endpoint = await probe();
		if (endpoint !== null) return endpoint;
		if (spawnFailed || (exitCode !== null && exitCode !== 0))
			throw new Error(
				"The engine could not start. Inspect engine/runtime.log in the application data directory.",
			);
		await delay(100, undefined, { signal });
	}
	throw new Error(
		"The engine did not become ready in time. It may still be starting; reconnect before launching another instance.",
	);
};
