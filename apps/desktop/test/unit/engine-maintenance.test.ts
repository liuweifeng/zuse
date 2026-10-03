import type { DesktopEngineEndpoint } from "@zusehq/server/desktop-engine";
import { expect, it, vi } from "vitest";
import { makeEngineMaintenance } from "../../src/engine-maintenance.ts";

const endpoint: DesktopEngineEndpoint = {
	version: 1,
	pid: 10,
	port: 1000,
	apiPort: 2000,
	token: "a".repeat(64),
	appVersion: "test",
};

it("holds launch admission through verified shutdown until the owning action releases it", async () => {
	let finish: () => void = () => {};
	const startup = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const shutdown = vi.fn(async () => "stopped" as const);
	const maintenance = makeEngineMaintenance({
		startup: () => startup,
		endpoint: async () => endpoint,
		shutdown,
	});
	const update = maintenance.scope();
	const preparing = update.prepare();
	expect(maintenance.blocked()).toBe(true);
	expect(shutdown).not.toHaveBeenCalled();
	const network = maintenance.scope();
	expect(await network.prepare()).toBe("busy");
	network.resume();
	expect(maintenance.blocked()).toBe(true);
	finish();
	expect(await preparing).toBe("stopped");
	expect(maintenance.blocked()).toBe(true);
	expect(shutdown).toHaveBeenCalledExactlyOnceWith(endpoint);
	update.resume();
	expect(maintenance.blocked()).toBe(false);
});

it("does not mistake a missing endpoint during worker restart for a stopped owner", async () => {
	const shutdown = vi.fn(async () => "stopped" as const);
	const maintenance = makeEngineMaintenance({
		startup: () => null,
		endpoint: async () => null,
		shutdown,
	});
	await expect(maintenance.scope().prepare()).rejects.toThrow("reconnecting");
	expect(shutdown).not.toHaveBeenCalled();
	expect(maintenance.blocked()).toBe(false);
});

it("restores launch admission after busy or failed shutdown without releasing a newer owner", async () => {
	const shutdown = vi
		.fn<() => Promise<"stopped" | "busy">>()
		.mockResolvedValueOnce("busy")
		.mockRejectedValueOnce(new Error("unverified"))
		.mockResolvedValue("stopped");
	const maintenance = makeEngineMaintenance({
		startup: () => null,
		endpoint: async () => endpoint,
		shutdown,
	});
	const old = maintenance.scope();
	expect(await old.prepare()).toBe("busy");
	expect(maintenance.blocked()).toBe(false);
	await expect(maintenance.scope().prepare()).rejects.toThrow("unverified");
	expect(maintenance.blocked()).toBe(false);
	const current = maintenance.scope();
	expect(await current.prepare()).toBe("stopped");
	old.resume();
	expect(maintenance.blocked()).toBe(true);
	current.resume();
	expect(maintenance.blocked()).toBe(false);
});
