import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDesktopApiPort } from "../../src/api-port.ts";

const servers: net.Server[] = [];

const listen = (port: number): Promise<net.Server> =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			servers.push(server);
			resolve(server);
		});
	});

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
});

describe("resolveDesktopApiPort", () => {
	it("moves the default api listener when its conventional port is occupied", async () => {
		const occupied = await listen(0);
		const address = occupied.address();
		expect(address).not.toBeNull();
		expect(typeof address).not.toBe("string");
		const preferredPort = (address as net.AddressInfo).port;

		const resolved = await resolveDesktopApiPort({
			configuredPort: undefined,
			defaultPort: preferredPort,
		});

		expect(resolved.port).not.toBe(preferredPort);
		expect(resolved.fellBack).toBe(true);
	});

	it("resolves zero to a concrete available port for the independent engine", async () => {
		const resolved = await resolveDesktopApiPort({ configuredPort: "0" });
		expect(resolved.fellBack).toBe(false);
		expect(resolved.port).toBeGreaterThan(0);
		expect(resolved.port).toBeLessThanOrEqual(65535);
		const listener = await listen(resolved.port);
		expect(listener.listening).toBe(true);
	});

	it("keeps an explicit nonzero api port unchanged, even when occupied", async () => {
		const occupied = await listen(0);
		const address = occupied.address();
		if (address === null || typeof address === "string")
			throw new Error("Missing TCP address");
		await expect(
			resolveDesktopApiPort({ configuredPort: String(address.port) }),
		).resolves.toEqual({ port: address.port, fellBack: false });
	});
});
