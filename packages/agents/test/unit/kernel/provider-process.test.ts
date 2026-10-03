import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	stopProviderProcess,
	watchProviderProcess,
} from "../../../src/kernel/provider-process.ts";

const processHasExited = async (pid: number): Promise<boolean> => {
	if (process.platform === "darwin") {
		try {
			const { stdout } = await promisify(execFile)("ps", [
				"-o",
				"stat=",
				"-p",
				String(pid),
			]);
			return stdout.trim() === "" || stdout.trim().startsWith("Z");
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === 1
			)
				return true;
			throw error;
		}
	}
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		// Orphan zombies are dead and may wait for the VM's init to reap them.
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return true;
		throw error;
	}
};

const launch = async (source: string) => {
	const child = spawn(process.execPath, ["-e", source], {
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	watchProviderProcess(child);
	await once(child.stdout, "data");
	return child;
};

const forceCleanup = (child: ChildProcess) => {
	try {
		if (process.platform !== "win32" && child.pid !== undefined)
			process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		/* already gone */
	}
};

describe("provider process shutdown", () => {
	it("waits for graceful exit and coalesces repeated close calls", async () => {
		const child = await launch(
			'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50)); setInterval(() => {}, 1000); console.log("ready");',
		);
		try {
			const first = stopProviderProcess(child, { processGroup: true });
			expect(stopProviderProcess(child, { processGroup: true })).toBe(first);
			await first;
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
			if (process.platform !== "win32") expect(child.exitCode).toBe(0);
		} finally {
			forceCleanup(child);
		}
	});

	it("forces a child that ignores termination to exit", async () => {
		const child = await launch(
			'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready");',
		);
		try {
			await stopProviderProcess(child, { processGroup: true });
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
			if (process.platform !== "win32")
				expect(child.signalCode).toBe("SIGKILL");
		} finally {
			forceCleanup(child);
		}
	});

	it
		.skipIf(process.platform !== "linux" && process.platform !== "darwin")
		.each([false, true])(
		"kills descendants after parent exit (automatic=%s)",
		async (automatic) => {
			const child = spawn(
				process.execPath,
				[
					"-e",
					`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready");'], { stdio: ["ignore", "pipe", "ignore"] });
descendant.stdout.once("data", () => console.log(descendant.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
				],
				{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
			);
			watchProviderProcess(child);
			const [data] = await once(child.stdout, "data");
			const pid = Number(String(data).trim());
			try {
				if (automatic) {
					const exit = once(child, "exit");
					child.kill("SIGTERM");
					await exit;
				} else {
					await stopProviderProcess(child, { processGroup: true });
				}
				expect(child.exitCode).toBe(0);
				await expect
					.poll(() => processHasExited(pid), { timeout: 4_000 })
					.toBe(true);
			} finally {
				forceCleanup(child);
			}
		},
	);
});
