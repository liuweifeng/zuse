import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	HarnessProcesses,
	type ProcessNotice,
	type ProcessOptions,
} from "../../src/harness/processes.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(overrides: Partial<ProcessOptions> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "zuse-processes-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const notices: ProcessNotice[] = [];
	const options = {
		rootId: "root",
		directory,
		notify: async (notice: ProcessNotice) => {
			notices.push(notice);
		},
		...overrides,
	};
	const host = new HarnessProcesses(options);
	await host.initialize();
	cleanup.push(() => host.close());
	return {
		host,
		options,
		directory,
		notices,
		start: (command: string, agentId = "root") =>
			host.start({
				agentId,
				file: "/bin/bash",
				args: ["-lc", command],
				cwd: directory,
				label: "test",
				timeoutMs: 3000,
				signal: new AbortController().signal,
			}),
	};
}
it("enforces concurrent launch capacity before asynchronous file creation", async () => {
	const f = await fixture({ maxRunning: 1 });
	const attempts = await Promise.allSettled([
		f.start("sleep 10"),
		f.start("sleep 10"),
	]);
	expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
});
it("bounds output artifacts and kills the producer", async () => {
	const f = await fixture({ maxOutputBytes: 4096 });
	const process = await f.start("yes payload");
	await f.host.wait(process.id, "root", 3000, new AbortController().signal);
	const output = await f.host.output(process.id, "root", 0, 64_000);
	expect(output.process.status).toBe("output_limit");
	expect((await readFile(output.artifact)).length).toBe(4096);
});
it("keeps completion notices on disk until durably accepted and bounds retained records", async () => {
	const f = await fixture({
		maxRetained: 1,
		notify: async () => {
			throw new Error("journal unavailable");
		},
	});
	for (let i = 0; i < 3; i++) {
		const process = await f.start("printf done");
		await f.host.wait(process.id, "root", 3000, new AbortController().signal);
	}
	expect(f.host.list("root")).toHaveLength(1);
	await f.host.close();
	const notices: ProcessNotice[] = [];
	const recovered = new HarnessProcesses({
		...f.options,
		notify: async (n) => {
			notices.push(n);
		},
	});
	await recovered.initialize();
	cleanup.push(() => recovered.close());
	expect(notices).toHaveLength(3);
	expect(new Set(notices.map((n) => n.id)).size).toBe(3);
	await recovered.close();
	const again = new HarnessProcesses({
		...f.options,
		notify: async (n) => {
			notices.push(n);
		},
	});
	await again.initialize();
	cleanup.push(() => again.close());
	expect(notices).toHaveLength(3);
});
it("interrupts one agent's processes without cancelling a sibling", async () => {
	const f = await fixture();
	const a = await f.start("sleep 10", "a");
	const b = await f.start("sleep 10", "b");
	await f.host.interruptAgents(["a"]);
	expect((await f.host.output(a.id, "root")).process.status).toBe("cancelled");
	expect((await f.host.output(b.id, "root")).process.status).toBe("running");
});
it("kills descendants left behind when the command exits", async () => {
	const f = await fixture();
	const p = await f.start("(sleep 1; printf orphan > marker) & printf done");
	await f.host.wait(p.id, "root", 3000, new AbortController().signal);
	expect((await f.host.output(p.id, "root")).process.status).toBe("exited");
	await new Promise((resolve) => setTimeout(resolve, 1200));
	await expect(readFile(join(f.directory, "marker"))).rejects.toThrow();
});

it("keeps session environment bindings isolated between process owners", async () => {
	const variable = "ZUSE_TEST_PROCESS_BINDING";
	const original = process.env[variable];
	const first = await fixture({
		rootId: "first",
		env: { ...process.env, [variable]: "first-only" },
	});
	const second = await fixture({
		rootId: "second",
		env: { ...process.env, [variable]: "second-only" },
	});
	for (const [f, expected] of [
		[first, "first-only"],
		[second, "second-only"],
	] as const) {
		const child = await f.start('printf "%s" "$ZUSE_TEST_PROCESS_BINDING"');
		await f.host.wait(child.id, "root", 3000, new AbortController().signal);
		const result = await f.host.output(child.id, "root");
		expect(result.text).toBe(expected);
	}
	expect(process.env[variable]).toBe(original);
});
