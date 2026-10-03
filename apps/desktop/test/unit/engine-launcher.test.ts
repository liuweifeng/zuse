import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DesktopEngineConfig,
	EngineChannel,
} from "@zusehq/server/desktop-engine";
import { expect, it } from "vitest";
import { publishEngineEndpoint } from "../../../server/src/desktop-engine/endpoint.ts";
import { EngineHost } from "../../../server/src/desktop-engine/host.ts";
import { listenLocalEngine } from "../../../server/src/desktop-engine/listener.ts";
import { ensureDesktopEngine } from "../../src/engine-launcher.ts";

it("reattaches to the live engine's API port without rewriting its launch configuration", async () => {
	const userData = await mkdtemp(join(tmpdir(), "zuse-engine-launcher-"));
	const token = randomBytes(32).toString("hex");
	const listener = await listenLocalEngine({
		token,
		host: new EngineHost(),
		clients: new Map<number, EngineChannel>(),
		onRpc: () => true,
		onDisconnect: () => {},
	});
	const config: DesktopEngineConfig = {
		userData,
		appVersion: "same",
		apiPort: 42001,
		bindHost: "127.0.0.1",
		advertisedHost: null,
		apiUrl: "http://127.0.0.1:9",
	};
	try {
		await publishEngineEndpoint(userData, {
			token,
			port: listener.port,
			apiPort: 42000,
			pid: process.pid,
			appVersion: "same",
		});
		const attached = await ensureDesktopEngine({
			config,
			supervisorPath: join(userData, "not-a-supervisor.cjs"),
		});
		expect(attached.apiPort).toBe(42000);
		expect(attached.pid).toBe(process.pid);
		await expect(
			readFile(join(userData, "engine", "launch.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			ensureDesktopEngine({
				config: { ...config, appVersion: "newer" },
				supervisorPath: "unused",
			}),
		).rejects.toThrow("different engine version");
		// An incompatible desktop must leave the existing owner reachable.
		expect(
			(await ensureDesktopEngine({ config, supervisorPath: "unused" })).pid,
		).toBe(process.pid);
	} finally {
		await listener.close();
		await rm(userData, { recursive: true, force: true });
	}
});

it("does not create launch state for an already-cancelled desktop startup", async () => {
	const userData = await mkdtemp(join(tmpdir(), "zuse-engine-cancel-"));
	try {
		await expect(
			ensureDesktopEngine({
				config: {
					userData,
					appVersion: "test",
					apiPort: 42000,
					bindHost: "127.0.0.1",
					advertisedHost: null,
					apiUrl: "http://127.0.0.1:9",
				},
				supervisorPath: "unused",
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow();
		await expect(
			readFile(join(userData, "engine", "launch.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
});
