import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	readDesktopEngineConfig,
	writeDesktopEngineConfig,
} from "../../src/desktop-engine/config.ts";
import {
	engineEndpointPath,
	publishEngineEndpoint,
	readEngineEndpoint,
	removeEngineEndpoint,
} from "../../src/desktop-engine/endpoint.ts";

it("publishes private endpoint metadata and fences cleanup by engine identity", async () => {
	const userData = await mkdtemp(join(tmpdir(), "zuse-engine-endpoint-"));
	try {
		expect(await readEngineEndpoint(userData)).toBeNull();
		const endpoint = {
			token: "a".repeat(64),
			port: 41000,
			apiPort: 41001,
			pid: process.pid,
			appVersion: "test",
		};
		await publishEngineEndpoint(userData, endpoint);
		expect(await readEngineEndpoint(userData)).toEqual({
			...endpoint,
			version: 1,
		});
		if (process.platform !== "win32") {
			expect((await stat(engineEndpointPath(userData))).mode & 0o777).toBe(
				0o600,
			);
			expect((await stat(join(userData, "engine"))).mode & 0o777).toBe(0o700);
		}
		await removeEngineEndpoint(userData, "b".repeat(64));
		expect(await readEngineEndpoint(userData)).not.toBeNull();
		await removeEngineEndpoint(userData, endpoint.token);
		expect(await readEngineEndpoint(userData)).toBeNull();
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
});

it("rejects malformed private configuration without including credential material", async () => {
	const userData = await mkdtemp(join(tmpdir(), "zuse-engine-config-"));
	try {
		const config = {
			userData,
			appVersion: "test",
			apiPort: 41000,
			bindHost: "127.0.0.1",
			advertisedHost: null,
			apiUrl: "http://127.0.0.1:9",
		};
		const path = await writeDesktopEngineConfig(config);
		expect(await readDesktopEngineConfig(path)).toEqual(config);
		if (process.platform !== "win32")
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		await writeFile(
			path,
			JSON.stringify({
				...config,
				apiPort: -1,
				nearbyTls: { key: "PRIVATE_MATERIAL" },
			}),
		);
		await expect(readDesktopEngineConfig(path)).rejects.toThrow(
			"configuration",
		);
		try {
			await readDesktopEngineConfig(path);
		} catch (error) {
			expect(String(error)).not.toContain("PRIVATE_MATERIAL");
		}
		await publishEngineEndpoint(userData, {
			token: "a".repeat(64),
			port: 41000,
			apiPort: 41001,
			pid: process.pid,
			appVersion: "test",
		});
		const endpointPath = engineEndpointPath(userData);
		const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
		await writeFile(endpointPath, JSON.stringify({ ...endpoint, port: 65536 }));
		await expect(readEngineEndpoint(userData)).rejects.toThrow(
			"endpoint is invalid",
		);
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
});
