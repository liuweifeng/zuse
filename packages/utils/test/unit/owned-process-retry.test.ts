import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { stopOwnedProcess } from "../../src/owned-process.ts";

it.skipIf(process.platform !== "linux")(
	"retries failed group observation and stops surviving descendants",
	async () => {
		const child = spawn(
			process.execPath,
			[
				"-e",
				`
const { spawn } = require("node:child_process");
const tool = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'], { stdio: ["ignore", "pipe", "ignore"] });
tool.stdout.once("data", () => console.log(tool.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
			],
			{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
		);
		const originalKill = process.kill.bind(process);
		let restore = () => {};
		try {
			const [chunk] = await once(child.stdout, "data");
			const toolPid = Number(String(chunk).trim());
			const exit = once(child, "exit");
			child.kill("SIGTERM");
			await exit;
			expect(Number.isInteger(toolPid)).toBe(true);
			const failure = Object.assign(
				new Error("temporary process observation failure"),
				{ code: "EACCES" },
			);
			let failObservation = true;
			const kill = vi
				.spyOn(process, "kill")
				.mockImplementation((pid, signal) => {
					if (pid === -Number(child.pid) && signal === 0 && failObservation) {
						failObservation = false;
						throw failure;
					}
					return originalKill(pid, signal);
				});
			restore = () => kill.mockRestore();
			const first = stopOwnedProcess(child, {
				processGroup: true,
				graceMs: 20,
			});
			expect(stopOwnedProcess(child, { processGroup: true })).toBe(first);
			await expect(first).rejects.toBe(failure);
			expect(originalKill(toolPid, 0)).toBe(true);
			const retry = stopOwnedProcess(child, {
				processGroup: true,
				graceMs: 20,
			});
			expect(retry).not.toBe(first);
			await retry;
			expect(stopOwnedProcess(child, { processGroup: true })).toBe(retry);
			try {
				const stat = await readFile(`/proc/${toolPid}/stat`, "utf8");
				expect(stat.slice(stat.lastIndexOf(")") + 2)).toMatch(/^[ZX] /);
			} catch (error) {
				expect(error).toMatchObject({ code: "ENOENT" });
			}
		} finally {
			restore();
			try {
				if (child.pid !== undefined) originalKill(-child.pid, "SIGKILL");
			} catch {}
		}
	},
);
