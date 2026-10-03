import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { stopOwnedProcess } from "@zuse/utils/owned-process";
import { expect, it, vi } from "vitest";
import { makeClaudeProcessOwner } from "../../../src/drivers/claude-process.ts";
import { stopProviderProcess } from "../../../src/kernel/provider-process.ts";

vi.mock("../../../src/kernel/provider-process.ts", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../src/kernel/provider-process.ts")
		>();
	return { ...actual, stopProviderProcess: vi.fn(actual.stopProviderProcess) };
});

it.skipIf(process.platform !== "linux")(
	"retries failed cleanup while keeping the owner closed to new launches",
	async () => {
		const owner = makeClaudeProcessOwner();
		const options = {
			command: process.execPath,
			args: ["-e", 'setInterval(() => {}, 1000); console.log("ready")'],
			env: process.env,
			signal: new AbortController().signal,
		};
		const child = owner.spawn(options);
		if (!(child instanceof ChildProcess))
			throw new Error("Expected a real SDK subprocess");
		try {
			if (child.stdout === null) throw new Error("Expected piped SDK output");
			await once(child.stdout, "data");
			const failure = new Error("temporary cleanup failure");
			vi.mocked(stopProviderProcess).mockRejectedValueOnce(failure);
			const first = owner.close();
			expect(owner.close()).toBe(first);
			await expect(first).rejects.toBe(failure);
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();
			expect(() => owner.spawn(options)).toThrow("owner is closed");
			const retry = owner.close();
			expect(retry).not.toBe(first);
			await retry;
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
			expect(owner.close()).toBe(retry);
			expect(() => owner.spawn(options)).toThrow("owner is closed");
		} finally {
			await stopOwnedProcess(child, { processGroup: true });
		}
	},
);
