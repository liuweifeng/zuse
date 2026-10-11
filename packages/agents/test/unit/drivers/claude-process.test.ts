import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { makeClaudeProcessOwner } from "../../../src/drivers/claude-process.ts";

const exited = async (pid: number) => {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		return /^[ZX] /.test(stat.slice(stat.lastIndexOf(")") + 2));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
};

it.skipIf(process.platform !== "linux").each([false, true])(
	"waits for the SDK process and its tools before close resolves (abort=%s)",
	async (abortFirst) => {
		const owner = makeClaudeProcessOwner();
		const abort = new AbortController();
		const child = owner.spawn({
			command: process.execPath,
			args: [
				"-e",
				`
const { spawn } = require("node:child_process");
const tool = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'], { stdio: ["ignore", "pipe", "ignore"] });
tool.stdout.once("data", () => console.log(JSON.stringify([process.pid, tool.pid])));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
			],
			env: process.env,
			signal: abort.signal,
		});
		try {
			const [chunk] = await once(child.stdout, "data");
			const pids: number[] = JSON.parse(String(chunk));
			expect(pids).toHaveLength(2);
			if (abortFirst) abort.abort();
			const closing = owner.close();
			expect(owner.close()).toBe(closing);
			await closing;
			for (const pid of pids) expect(await exited(pid)).toBe(true);
			expect(() =>
				owner.spawn({
					command: process.execPath,
					args: [],
					env: {},
					signal: new AbortController().signal,
				}),
			).toThrow("owner is closed");
		} finally {
			await owner.close();
		}
	},
);

it("rejects an already cancelled SDK launch before spawning", async () => {
	const owner = makeClaudeProcessOwner();
	expect(() =>
		owner.spawn({
			command: "must-not-spawn",
			args: [],
			env: {},
			signal: AbortSignal.abort(),
		}),
	).toThrow();
	await owner.close();
});
