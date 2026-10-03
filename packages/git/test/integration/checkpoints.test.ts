import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	link,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureGitCheckpoint,
	readGitCheckpoint,
	restoreGitCheckpoint,
} from "../../src/checkpoints.ts";

const execute = promisify(execFile);
const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) =>
	(await execute("git", ["-C", cwd, ...args])).stdout.trim();
const repo = async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "zuse-checkpoint-test-"));
	roots.push(cwd);
	await git(cwd, "init", "-q");
	await git(cwd, "config", "user.name", "Test");
	await git(cwd, "config", "user.email", "test@example.com");
	await writeFile(path.join(cwd, "file.txt"), "initial\n");
	await git(cwd, "add", ".");
	await git(cwd, "commit", "-qm", "initial");
	return cwd;
};
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
describe("Git turn checkpoints", () => {
	it("preserves dirty staged state and restores tracked, deleted, untracked and binary files without moving HEAD", async () => {
		const cwd = await repo();
		await writeFile(path.join(cwd, "file.txt"), "staged\n");
		await git(cwd, "add", "file.txt");
		await writeFile(path.join(cwd, "file.txt"), "working\n");
		await writeFile(path.join(cwd, "binary"), Buffer.from([0, 1, 2]));
		const status = await git(cwd, "status", "--porcelain");
		const head = await git(cwd, "rev-parse", "HEAD");
		const baseline = await captureGitCheckpoint(cwd, "baseline");
		expect(await git(cwd, "status", "--porcelain")).toBe(status);
		await rm(path.join(cwd, "file.txt"));
		await writeFile(path.join(cwd, "binary"), Buffer.from([0, 3, 4]));
		await writeFile(path.join(cwd, "new.txt"), "new\n");
		await git(cwd, "add", "-A");
		const after = await captureGitCheckpoint(cwd, "after");
		await restoreGitCheckpoint(cwd, baseline.id, after.id);
		expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
			"working\n",
		);
		expect(await readFile(path.join(cwd, "binary"))).toEqual(
			Buffer.from([0, 1, 2]),
		);
		expect(await git(cwd, "show", ":file.txt")).toBe("staged");
		expect(await git(cwd, "status", "--porcelain")).toBe(status);
		expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
		await restoreGitCheckpoint(cwd, baseline.id, after.id); // crash/retry after success
	});
	it("reuses durable refs after restart and rejects external edits, changed HEAD, and different worktrees", async () => {
		const cwd = await repo();
		const baseline = await captureGitCheckpoint(cwd, "baseline");
		await writeFile(path.join(cwd, "file.txt"), "after\n");
		const after = await captureGitCheckpoint(cwd, "after");
		expect((await captureGitCheckpoint(cwd, "baseline")).commit).toBe(
			baseline.commit,
		);
		expect((await readGitCheckpoint(cwd, "after"))?.commit).toBe(after.commit);
		await writeFile(path.join(cwd, "file.txt"), "external\n");
		await expect(
			restoreGitCheckpoint(cwd, "baseline", "after"),
		).rejects.toThrow("changed");
		expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
			"external\n",
		);
		const second = path.join(cwd, "..", `checkpoint-worktree-${Date.now()}`);
		roots.push(second);
		await git(cwd, "worktree", "add", "--detach", second);
		await expect(readGitCheckpoint(second, "baseline")).rejects.toThrow(
			"different checkout",
		);
	});
	it("recovers its index alias after a crash immediately after the final rename", async () => {
		const cwd = await repo();
		await captureGitCheckpoint(cwd, "before");
		await writeFile(path.join(cwd, "file.txt"), "changed\n");
		await captureGitCheckpoint(cwd, "after");
		await restoreGitCheckpoint(cwd, "before", "after");
		const digest = createHash("sha256").update("before:after").digest("hex");
		await link(
			path.join(cwd, ".git/index"),
			path.join(cwd, `.git/zuse-restore-${digest}.index`),
		);
		await restoreGitCheckpoint(cwd, "before", "after");
		expect(await git(cwd, "show", ":file.txt")).toBe("initial");
		expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
			"initial\n",
		);
	});
	it("uses the repository root when a project points at a nested directory", async () => {
		const cwd = await repo();
		const nested = path.join(cwd, "nested");
		await mkdir(nested);
		await captureGitCheckpoint(nested, "before");
		await writeFile(path.join(cwd, "file.txt"), "outside nested project\n");
		await writeFile(path.join(nested, "added"), "added\n");
		await captureGitCheckpoint(nested, "after");
		await restoreGitCheckpoint(nested, "before", "after");
		expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
			"initial\n",
		);
		expect(await git(cwd, "status", "--porcelain")).toBe("");
	});
	it("does not trust a freshly copied index over same-timestamp file edits", async () => {
		const cwd = await repo();
		await git(cwd, "config", "core.trustctime", "false");
		await git(cwd, "config", "core.checkStat", "minimal");
		const past = new Date("2000-01-01T00:00:00Z");
		await utimes(path.join(cwd, "file.txt"), past, past);
		await git(cwd, "update-index", "--refresh");
		await utimes(path.join(cwd, ".git/index"), past, past);
		const baseline = await captureGitCheckpoint(cwd, "before");
		await writeFile(path.join(cwd, "file.txt"), "changed\n");
		await utimes(path.join(cwd, "file.txt"), past, past);
		const after = await captureGitCheckpoint(cwd, "after");
		expect(after.tree).not.toBe(baseline.tree);
		await restoreGitCheckpoint(cwd, "before", "after");
		expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
			"initial\n",
		);
	});
	it("supports unborn repositories and leaves ignored files untouched", async () => {
		const cwd = await mkdtemp(
			path.join(os.tmpdir(), "zuse-checkpoint-unborn-"),
		);
		roots.push(cwd);
		await git(cwd, "init", "-q");
		await writeFile(path.join(cwd, ".gitignore"), "secret\n");
		await writeFile(path.join(cwd, "secret"), "secret");
		const baseline = await captureGitCheckpoint(cwd, "before");
		await writeFile(path.join(cwd, "added"), "new");
		await captureGitCheckpoint(cwd, "after");
		await restoreGitCheckpoint(cwd, baseline.id, "after");
		expect(await readFile(path.join(cwd, "secret"), "utf8")).toBe("secret");
		expect(await git(cwd, "ls-files")).toBe("");
	});
	it("refuses to overwrite an ignored file that collides with a restored path", async () => {
		const cwd = await repo();
		const baseline = await captureGitCheckpoint(cwd, "before");
		await rm(path.join(cwd, "file.txt"));
		await git(cwd, "add", "-A");
		await writeFile(path.join(cwd, ".gitignore"), "file.txt\n");
		await captureGitCheckpoint(cwd, "after");
		await writeFile(path.join(cwd, "file.txt"), "private ignored\n");
		await expect(
			restoreGitCheckpoint(cwd, baseline.id, "after"),
		).rejects.toThrow();
		expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
			"private ignored\n",
		);
	});
});
