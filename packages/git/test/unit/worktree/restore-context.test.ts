import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { mergeArchivedContext } from "../../../src/worktree/restore-context.ts";

const roots: string[] = [];
const fixture = async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-context-restore-"));
	roots.push(root);
	const archived = join(root, "archive");
	const restored = join(root, "checkout", ".context");
	await mkdir(archived, { recursive: true });
	await mkdir(restored, { recursive: true });
	return { root, archived, restored };
};
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

test("preserves both nonconflicting context trees and deduplicates checkpoint copies", async () => {
	const { archived, restored } = await fixture();
	await writeFile(join(archived, "same.log"), "identical");
	await writeFile(join(restored, "same.log"), "identical");
	await writeFile(join(archived, "archive-only.txt"), "archive");
	await writeFile(join(restored, "checkpoint-only.txt"), "checkpoint");
	await mergeArchivedContext(archived, restored);
	expect(await readFile(join(restored, "same.log"), "utf8")).toBe("identical");
	expect(await readFile(join(restored, "archive-only.txt"), "utf8")).toBe(
		"archive",
	);
	expect(await readFile(join(restored, "checkpoint-only.txt"), "utf8")).toBe(
		"checkpoint",
	);
	expect(await readFile(join(archived, "archive-only.txt"), "utf8")).toBe(
		"archive",
	);
});

test("divergent files fail preflight without copying or overwriting either version", async () => {
	const { archived, restored } = await fixture();
	await writeFile(join(archived, "a-new.txt"), "must stay archived");
	await writeFile(join(archived, "z-conflict.txt"), "archived version");
	await writeFile(join(restored, "z-conflict.txt"), "checkpoint version");
	await expect(mergeArchivedContext(archived, restored)).rejects.toThrow(
		`Context restore conflict: ${join(restored, "z-conflict.txt")}`,
	);
	expect(await readFile(join(archived, "z-conflict.txt"), "utf8")).toBe(
		"archived version",
	);
	expect(await readFile(join(restored, "z-conflict.txt"), "utf8")).toBe(
		"checkpoint version",
	);
	await expect(lstat(join(restored, "a-new.txt"))).rejects.toMatchObject({
		code: "ENOENT",
	});
});

test("never follows a materialized directory symlink to write outside context", async () => {
	const { root, archived, restored } = await fixture();
	await mkdir(join(archived, "files"));
	await writeFile(join(archived, "files", "note.txt"), "preserved");
	await mkdir(join(root, "outside"));
	await symlink(join(root, "outside"), join(restored, "files"));
	await expect(mergeArchivedContext(archived, restored)).rejects.toThrow(
		"Context restore conflict",
	);
	await expect(lstat(join(root, "outside", "note.txt"))).rejects.toMatchObject({
		code: "ENOENT",
	});
	expect(await readFile(join(archived, "files", "note.txt"), "utf8")).toBe(
		"preserved",
	);
});
