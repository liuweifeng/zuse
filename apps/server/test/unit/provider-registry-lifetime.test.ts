import { spawn } from "node:child_process";
import { once } from "node:events";
import { stopOwnedProcess } from "@zuse/utils/owned-process";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { ownProviderRegistry } from "../../src/provider/provider-handle-cleanup.ts";
import { makeProviderSessionRegistry } from "../../src/provider/provider-session-registry.ts";

test("provider scope disposal stops a published idle process and rejects late publication", async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
	});
	await once(child, "spawn");
	const entry = {
		handle: { close: () => Effect.promise(() => stopOwnedProcess(child)) },
	};
	const registry = makeProviderSessionRegistry<string, typeof entry>();
	const pending = registry.begin("pending");
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* ownProviderRegistry(registry);
					const generation = registry.begin("idle");
					expect(registry.publish("idle", generation, entry)).toBe(true);
					expect(child.exitCode).toBeNull();
					expect(child.signalCode).toBeNull();
				}),
			),
		);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(registry.lookup("idle")).toBeUndefined();
		expect(registry.currentGeneration("pending")).toBeUndefined();
		expect(registry.publish("pending", pending, entry)).toBe(false);
		expect(registry.publish("new", registry.begin("new"), entry)).toBe(false);
		expect(registry.close()).toEqual([]);
	} finally {
		await stopOwnedProcess(child);
	}
});
