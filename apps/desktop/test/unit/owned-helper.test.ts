import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const running = (pid: number): boolean => {
	try {
		return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.startsWith("Z");
	} catch {
		return false;
	}
};

it.skipIf(process.platform === "win32").each(["EOF", "SIGKILL"] as const)(
	"retires a stubborn native helper after owner %s",
	async (mode) => {
		const owner = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				fileURLToPath(new URL("../fixtures/owned-helper.ts", import.meta.url)),
				"owner",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		const pids = new Map<string, number>();
		let output = "";
		let errors = "";
		owner.stderr.on("data", (chunk) => {
			errors += String(chunk);
		});
		owner.stdout.on("data", (chunk) => {
			output += String(chunk);
			while (output.includes("\n")) {
				const newline = output.indexOf("\n");
				const line = output.slice(0, newline);
				output = output.slice(newline + 1);
				const record = JSON.parse(line);
				for (const [key, value] of Object.entries(record))
					if (typeof value === "number") pids.set(key, value);
			}
		});
		const exited = new Promise<void>((resolve) =>
			owner.once("exit", () => resolve()),
		);
		try {
			await expect
				.poll(() => pids.size, { timeout: 10_000, message: errors })
				.toBe(2);
			for (const pid of pids.values()) expect(running(pid)).toBe(true);
			if (mode === "SIGKILL") owner.kill("SIGKILL");
			else owner.stdin.end();
			await expect
				.poll(() => [...pids.values()].every((pid) => !running(pid)), {
					timeout: 10_000,
				})
				.toBe(true);
			await exited;
		} finally {
			owner.kill("SIGKILL");
			for (const pid of pids.values()) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			await exited;
		}
	},
	20_000,
);
