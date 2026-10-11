import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import type {
	DesktopEngineConfig,
	EngineChannel,
} from "@zusehq/server/desktop-engine";
import { expect, it } from "vitest";
import { publishEngineEndpoint } from "../../../server/src/desktop-engine/endpoint.ts";
import { EngineHost } from "../../../server/src/desktop-engine/host.ts";
import { listenLocalEngine } from "../../../server/src/desktop-engine/listener.ts";
import {
	ensureDesktopEngine,
	readEngineBuildId,
} from "../../src/engine-launcher.ts";

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
		buildId: "same-build",
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
			buildId: "same-build",
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
		await expect(
			ensureDesktopEngine({
				config: { ...config, buildId: "rebuilt-with-same-version" },
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

it("detects changes to either executable regardless of its release version", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-engine-build-"));
	const supervisor = join(directory, "engine-supervisor.cjs");
	const worker = join(directory, "engine-main.cjs");
	try {
		await Promise.all([
			writeFile(supervisor, "supervisor"),
			writeFile(worker, "worker"),
		]);
		const first = await readEngineBuildId(supervisor);
		expect(await readEngineBuildId(supervisor)).toBe(first);
		await writeFile(worker, "new worker");
		const second = await readEngineBuildId(supervisor);
		expect(second).not.toBe(first);
		await writeFile(supervisor, "new supervisor");
		expect(await readEngineBuildId(supervisor)).not.toBe(second);
	} finally {
		await rm(directory, { recursive: true, force: true });
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

it.each([
	[401, WIRE_PROTOCOL_VERSION, true],
	[200, WIRE_PROTOCOL_VERSION, true],
	[200, WIRE_PROTOCOL_VERSION + 1, false],
	[200, null, false],
	[500, WIRE_PROTOCOL_VERSION, false],
] as const)("reattaches a rebuilt desktop only with verified compatibility (HTTP %s, protocol %s)", async (status, protocolVersion, compatible) => {
	const userData = await mkdtemp(join(tmpdir(), "zuse-engine-rebuild-"));
	const token = randomBytes(32).toString("hex");
	let shutdownChecks = 0;
	const listener = await listenLocalEngine({
		token,
		host: new EngineHost(),
		clients: new Map<number, EngineChannel>(),
		onRpc: () => true,
		onDisconnect: () => {},
		prepareShutdown: async () => {
			shutdownChecks++;
			return false;
		},
		shutdown: () => {
			throw new Error("must not stop active work");
		},
	});
	const api = createServer((request, response) => {
		expect(request.url).toBe("/auth/cli-session");
		response.writeHead(status, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				error: "unauthorized",
				protocolVersion,
			}),
		);
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	const address = api.address();
	if (address === null || typeof address === "string")
		throw new Error("missing port");
	const config: DesktopEngineConfig = {
		userData,
		appVersion: "same",
		buildId: "new-build",
		apiPort: address.port,
		bindHost: "127.0.0.1",
		advertisedHost: null,
		apiUrl: "http://127.0.0.1:9",
	};
	try {
		await publishEngineEndpoint(userData, {
			token,
			port: listener.port,
			apiPort: address.port,
			pid: process.pid,
			appVersion: "same",
			buildId: "old-build",
		});
		const attach = () =>
			ensureDesktopEngine({ config, supervisorPath: "must-not-spawn" });
		if (compatible) {
			const endpoint = await attach();
			expect(endpoint.buildId).toBe("old-build");
			expect((await attach()).token).toBe(endpoint.token);
		} else {
			await expect(attach()).rejects.toThrow("different engine version");
		}
		expect(shutdownChecks).toBe(1);
		await expect(
			readFile(join(userData, "engine", "launch.json")),
		).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await listener.close();
		await new Promise<void>((resolve, reject) =>
			api.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(userData, { recursive: true, force: true });
	}
});
