import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { SyncFileVerifier } from "../../src/sync/cloud-sync-file-verifier.ts";
import {
	applySnapshot,
	cachedBaseline,
	localBaseline,
} from "../../src/sync/cloud-sync-snapshot.ts";

const digest = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");

test("fresh files bypass cached hashes within the filesystem timestamp tick", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-sync-verifier-"));
	const path = join(root, "file");
	const read = vi.fn(digest);
	const verifier = new SyncFileVerifier(read);
	try {
		await writeFile(path, "original");
		await verifier.digest(path);
		await verifier.digest(path);
		expect(read).toHaveBeenCalledTimes(2);
		await writeFile(path, "modified");
		expect(await verifier.digest(path)).toBe(await digest(path));
		expect(read).toHaveBeenCalledTimes(3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sync phases share verified bytes but recheck local edits and corrupt objects", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-sync-verifier-"));
	const path = join(root, "file");
	const read = vi.fn(digest);
	const verifier = new SyncFileVerifier(read);
	try {
		await writeFile(path, "original");
		const info = await stat(path);
		const file = {
			path: "file",
			hash: await digest(path),
			size: 8,
			mode: info.mode & 0o777,
		};
		await mkdir(join(root, "objects"));
		const object = join(root, "objects", file.hash);
		await writeFile(object, "original");
		await writeFile(join(root, "received.ndjson"), `${JSON.stringify(file)}\n`);
		await delay(1_100);
		const previous = {
			version: 1 as const,
			workspaceId: "test",
			files: [file],
		};
		const signal = new AbortController().signal;
		expect(await localBaseline(root, [file], verifier)).toEqual([file]);
		await applySnapshot(root, root, previous, [file], signal, verifier);
		expect(await localBaseline(root, [file], verifier)).toEqual([file]);
		expect(read).toHaveBeenCalledTimes(1);

		await writeFile(path, "modified");
		await utimes(path, info.atime, info.mtime);
		expect(await localBaseline(root, [file], verifier)).toEqual([]);
		expect(read).toHaveBeenCalledTimes(2);
		await writeFile(join(root, "replacement"), "original");
		await rename(join(root, "replacement"), path);
		expect(await localBaseline(root, [file], verifier)).toEqual([file]);
		expect(read).toHaveBeenCalledTimes(3);

		expect(await cachedBaseline(root, verifier)).toEqual([file]);
		expect(await cachedBaseline(root, verifier)).toEqual([file]);
		expect(read).toHaveBeenCalledTimes(4);
		await writeFile(object, "corrupt!");
		expect(await cachedBaseline(root, verifier)).toEqual([]);
		expect(read).toHaveBeenCalledTimes(5);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("verification expires, does not survive restart, and rejects files changing during hashing", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-sync-verifier-"));
	const path = join(root, "file");
	let now = 0;
	const read = vi.fn(digest);
	const verifier = new SyncFileVerifier(read, () => now);
	try {
		await writeFile(path, "original");
		await delay(1_100);
		const hash = await verifier.digest(path);
		now = 299_999;
		expect(await verifier.digest(path)).toBe(hash);
		expect(read).toHaveBeenCalledTimes(1);
		now = 300_000;
		expect(await verifier.digest(path)).toBe(hash);
		expect(read).toHaveBeenCalledTimes(2);
		expect(await new SyncFileVerifier(read).digest(path)).toBe(hash);
		expect(read).toHaveBeenCalledTimes(3);
		const racing = new SyncFileVerifier(async (target) => {
			const result = await digest(target);
			await writeFile(target, "changed during read");
			return result;
		});
		await expect(racing.digest(path)).rejects.toThrow("changed during sync");
		await symlink(path, join(root, "link"));
		await expect(verifier.digest(join(root, "link"))).rejects.toThrow(
			"regular file",
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			localBaseline(
				root,
				[{ path: "file", hash, mode: 0o644, size: 8 }],
				verifier,
				controller.signal,
			),
		).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
