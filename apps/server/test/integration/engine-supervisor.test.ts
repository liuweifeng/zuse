import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { superviseEngine } from "../../src/desktop-engine/supervisor.ts";

it("restarts a failed worker, excludes another supervisor, and waits for shutdown", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-supervisor-"));
	const controller = new AbortController();
	const children: ChildProcess[] = [];
	const messages: string[] = [];
	const work = superviseEngine({
		userData: directory,
		signal: controller.signal,
		restartDelayMs: 5,
		shutdownGraceMs: 25,
		log: (text) => {
			messages.push(text);
		},
		spawnWorker: () => {
			const child = spawn(
				process.execPath,
				[
					"-e",
					'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			children.push(child);
			return child;
		},
	});
	try {
		await expect
			.poll(() => messages.filter((text) => text.includes("ready")).length)
			.toBe(1);
		await superviseEngine({
			userData: directory,
			signal: controller.signal,
			log: () => {},
			spawnWorker: () => {
				throw new Error("duplicate supervisor started a worker");
			},
		});
		expect(children).toHaveLength(1);
		children[0]?.kill("SIGKILL");
		await expect
			.poll(() => messages.filter((text) => text.includes("ready")).length)
			.toBe(2);
		controller.abort();
		await work;
		expect(children).toHaveLength(2);
		expect(
			children.every(
				(child) => child.exitCode !== null || child.signalCode !== null,
			),
		).toBe(true);
	} finally {
		controller.abort();
		await work;
		await rm(directory, { recursive: true, force: true });
	}
});

it("bounds repeated startup failures and releases ownership for a later retry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-supervisor-failure-"));
	let count = 0;
	try {
		await expect(
			superviseEngine({
				userData: directory,
				signal: new AbortController().signal,
				restartDelayMs: 1,
				maxRapidFailures: 3,
				log: () => {},
				spawnWorker: () => {
					count++;
					return spawn(process.execPath, ["-e", "process.exit(1)"], {
						stdio: "ignore",
					});
				},
			}),
		).rejects.toThrow("repeatedly failed");
		expect(count).toBe(3);
		await superviseEngine({
			userData: directory,
			signal: new AbortController().signal,
			log: () => {},
			spawnWorker: () => {
				count++;
				return spawn(process.execPath, ["-e", "process.exit(0)"], {
					stdio: "ignore",
				});
			},
		});
		expect(count).toBe(4);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
