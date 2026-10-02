import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { tryAcquireProcessLock } from "../../src/process-lock.js";

const moduleUrl = new URL("../../src/process-lock.ts", import.meta.url).href;
const startOwner = (filename: string) => {
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--input-type=module",
			"--eval",
			`import { tryAcquireProcessLock } from ${JSON.stringify(moduleUrl)};
		 const lock = tryAcquireProcessLock(process.argv[1]);
		 process.send(lock === null ? "busy" : "owned");
		 if (lock === null) process.exit(2);
		 setInterval(() => {}, 1000);`,
			filename,
		],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	const exited = once(child, "exit");
	const ready = Promise.race([
		once(child, "message").then(([message]) => message),
		exited.then(() => {
			throw new Error("Lock owner exited before reporting ownership");
		}),
	]);
	return { child, ready, exited };
};

describe("SQLite process ownership", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "sqlite-lock-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test("keeps one owner across failed acquisition and idempotent release", () => {
		const filename = join(directory, "owner.sqlite");
		const owner = tryAcquireProcessLock(filename);
		expect(owner).not.toBeNull();
		try {
			expect(tryAcquireProcessLock(filename)).toBeNull();
			expect(tryAcquireProcessLock(filename)).toBeNull();
			owner?.release();
			const replacement = tryAcquireProcessLock(filename);
			expect(replacement).not.toBeNull();
			try {
				owner?.release();
				expect(tryAcquireProcessLock(filename)).toBeNull();
			} finally {
				replacement?.release();
			}
		} finally {
			owner?.release();
		}
	});

	test("allows independent directories and propagates IO failures", () => {
		const first = tryAcquireProcessLock(join(directory, "first.sqlite"));
		const second = tryAcquireProcessLock(join(directory, "second.sqlite"));
		try {
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
			expect(() =>
				tryAcquireProcessLock(join(directory, "missing", "lock.sqlite")),
			).toThrow();
		} finally {
			first?.release();
			second?.release();
		}
	});

	test("rejects a competing process while the parent owns the lock", async () => {
		const filename = join(directory, "owner.sqlite");
		const owner = tryAcquireProcessLock(filename);
		const contender = startOwner(filename);
		try {
			expect(await contender.ready).toBe("busy");
		} finally {
			contender.child.kill("SIGKILL");
			await contender.exited;
			owner?.release();
		}
	});

	test("retains ownership during suspension and recovers after process death", async () => {
		const filename = join(directory, "owner.sqlite");
		const owner = startOwner(filename);
		try {
			expect(await owner.ready).toBe("owned");
			if (process.platform !== "win32") owner.child.kill("SIGSTOP");
			expect(tryAcquireProcessLock(filename)).toBeNull();
		} finally {
			owner.child.kill("SIGKILL");
			await owner.exited;
		}
		const recovered = tryAcquireProcessLock(filename);
		try {
			expect(recovered).not.toBeNull();
		} finally {
			recovered?.release();
		}
	});
});
