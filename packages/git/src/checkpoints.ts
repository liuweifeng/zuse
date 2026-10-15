import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFile,
	link,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";

const execute = promisify(execFile);
const ObjectId = Schema.String.check(
	Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
);
const SnapshotMetadata = Schema.Struct({
	version: Schema.Literal(1),
	id: Schema.String,
	root: Schema.String,
	gitDir: Schema.String,
	head: Schema.NullOr(ObjectId),
	indexTree: ObjectId,
});
export class GitCheckpointPreconditionError extends Error {
	readonly _tag = "GitCheckpointPreconditionError";
}

export interface GitCheckpoint {
	readonly id: string;
	readonly ref: string;
	readonly commit: string;
	readonly tree: string;
	readonly indexTree: string;
	readonly head: string | null;
	readonly root: string;
	readonly gitDir: string;
}

const environment = (index?: string): NodeJS.ProcessEnv => {
	const env = { ...process.env };
	for (const name of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_COMMON_DIR",
	])
		delete env[name];
	if (index !== undefined) env.GIT_INDEX_FILE = index;
	return {
		...env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Zuse",
		GIT_AUTHOR_EMAIL: "zuse@localhost",
		GIT_COMMITTER_NAME: "Zuse",
		GIT_COMMITTER_EMAIL: "zuse@localhost",
	};
};
const git = async (
	cwd: string,
	args: readonly string[],
	index?: string,
): Promise<string> =>
	(
		await execute("git", ["-C", cwd, ...args], {
			env: environment(index),
			maxBuffer: 64 * 1024 * 1024,
			timeout: 60_000,
		})
	).stdout;
const digest = (id: string) => createHash("sha256").update(id).digest("hex");
const reference = (id: string) => `refs/zuse/checkpoints/${digest(id)}`;
const owner = async (cwd: string) => ({
	root: await realpath(
		(await git(cwd, ["rev-parse", "--show-toplevel"])).trim(),
	),
	gitDir: await realpath(
		(await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim(),
	),
});
const currentHead = async (cwd: string): Promise<string | null> => {
	try {
		return (await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
	} catch {
		await git(cwd, ["symbolic-ref", "HEAD"]);
		return null;
	}
};

/** Private refs keep both working files and the staged tree reachable from Git GC. */
export const readGitCheckpoint = async (
	cwd: string,
	id: string,
): Promise<GitCheckpoint | null> => {
	const location = await owner(cwd);
	const ref = reference(id);
	let commit: string;
	try {
		commit = (await git(cwd, ["rev-parse", "--verify", "--quiet", ref])).trim();
	} catch {
		return null;
	}
	const metadata = Schema.decodeUnknownSync(
		Schema.fromJsonString(SnapshotMetadata),
	)((await git(cwd, ["show", "-s", "--format=%B", commit])).trim());
	if (
		metadata.id !== id ||
		metadata.root !== location.root ||
		metadata.gitDir !== location.gitDir
	)
		throw new Error("Checkpoint belongs to a different checkout.");
	return {
		...metadata,
		ref,
		commit,
		tree: (await git(cwd, ["rev-parse", `${commit}^{tree}`])).trim(),
	};
};

const withTemporaryIndex = async <A>(
	cwd: string,
	run: (index: string) => Promise<A>,
): Promise<A> => {
	const directory = path.join(os.tmpdir(), `zuse-checkpoint-${randomUUID()}`);
	await mkdir(directory, { mode: 0o700 });
	const index = path.join(directory, "index");
	try {
		const indexPath = (
			await git(cwd, [
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"index",
			])
		).trim();
		try {
			const sourceStat = await stat(indexPath);
			await copyFile(indexPath, index);

			await utimes(index, sourceStat.atime, sourceStat.mtime);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await git(cwd, ["read-tree", "--empty"], index);
		}
		return await run(index);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

const observe = async (cwd: string, index: string) => {
	const head = await currentHead(cwd);
	const indexStat = await stat(index);
	const indexTree = (await git(cwd, ["write-tree"], index)).trim();

	await utimes(index, indexStat.atime, indexStat.mtime);
	await git(cwd, ["add", "-A", "--", "."], index);
	const tree = (await git(cwd, ["write-tree"], index)).trim();
	if (head !== (await currentHead(cwd)))
		throw new Error("Checkout HEAD changed while capturing a checkpoint.");
	return { head, indexTree, tree };
};

/** Idempotent for an operation id; never changes the user's HEAD, index or files. */
export const captureGitCheckpoint = async (
	cwd: string,
	id: string,
): Promise<GitCheckpoint> => {
	const existing = await readGitCheckpoint(cwd, id);
	if (existing !== null) return existing;
	const location = await owner(cwd);
	return withTemporaryIndex(location.root, async (index) => {
		const observed = await observe(location.root, index);
		const metadata = {
			version: 1 as const,
			id,
			...location,
			head: observed.head,
			indexTree: observed.indexTree,
		};
		const indexCommit = (
			await git(location.root, [
				"commit-tree",
				observed.indexTree,
				"-m",
				"Zuse checkpoint index",
			])
		).trim();
		const commit = (
			await git(location.root, [
				"commit-tree",
				observed.tree,
				"-p",
				indexCommit,
				...(observed.head === null ? [] : ["-p", observed.head]),
				"-m",
				JSON.stringify(metadata),
			])
		).trim();
		const ref = reference(id);
		try {
			await git(location.root, [
				"update-ref",
				ref,
				commit,
				"0".repeat(commit.length),
			]);
		} catch (error) {
			const winner = await readGitCheckpoint(cwd, id);
			if (winner !== null) return winner;
			throw error;
		}
		return { ...metadata, ...observed, ref, commit };
	});
};

const prepareRestorePatch = async (
	cwd: string,
	target: GitCheckpoint,
	expected: GitCheckpoint,
	temporary: string,
): Promise<string | null> => {
	if (target.head !== expected.head)
		throw new GitCheckpointPreconditionError(
			"Rollback across a changed branch or commit is not supported.",
		);

	const current = await observe(cwd, temporary);
	if (
		current.head !== expected.head ||
		![expected.tree, target.tree].includes(current.tree) ||
		![expected.indexTree, target.indexTree].includes(current.indexTree)
	)
		throw new GitCheckpointPreconditionError(
			"Files or staging changed since this rollback was prepared. Refresh before restoring.",
			{ cause: { current, expected, target } },
		);
	if (current.tree !== target.tree) {
		const patch = await git(cwd, [
			"diff",
			"--binary",
			"--full-index",
			"--no-ext-diff",
			"--no-renames",
			expected.tree,
			target.tree,
			"--",
		]);
		const patchPath = `${temporary}.patch`;
		await writeFile(patchPath, patch, { mode: 0o600 });

		try {
			await git(cwd, [
				"apply",
				"--check",
				"--binary",
				"--whitespace=nowarn",
				patchPath,
			]);
		} catch {
			throw new GitCheckpointPreconditionError(
				"Files conflict with this checkpoint. Nothing was restored; review a fresh preview.",
			);
		}
		return patchPath;
	}
	return null;
};

/** Best-effort preflight before a different atomic domain (native history) is changed. */
export const validateGitCheckpointRestore = async (
	cwd: string,
	targetId: string,
	expectedId: string,
): Promise<void> => {
	const target = await readGitCheckpoint(cwd, targetId);
	const expected = await readGitCheckpoint(cwd, expectedId);
	if (target === null || expected === null)
		throw new Error("Checkpoint is missing.");
	await withTemporaryIndex(target.root, async (temporary) => {
		await prepareRestorePatch(target.root, target, expected, temporary);
	});
};

/**
 * Restore only from the exact advertised state. A caller must durably fence all
 * engine writers for this checkout before calling. External edits make this
 * fail closed. An interrupted restore can resume after the file or index phase.
 * HEAD never moves and ignored/unrelated files are never cleaned.
 */
export const restoreGitCheckpoint = async (
	cwd: string,
	targetId: string,
	expectedId: string,
): Promise<void> => {
	const target = await readGitCheckpoint(cwd, targetId);
	const expected = await readGitCheckpoint(cwd, expectedId);
	if (target === null || expected === null)
		throw new Error("Checkpoint is missing.");
	cwd = target.root;
	if (target.head !== expected.head)
		throw new GitCheckpointPreconditionError(
			"Rollback across a changed branch or commit is not supported.",
		);
	const indexPath = (
		await git(cwd, [
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"index",
		])
	).trim();
	const lock = `${indexPath}.lock`;
	const ownedIndex = path.join(
		target.gitDir,
		`zuse-restore-${digest(`${targetId}:${expectedId}`)}.index`,
	);

	try {
		const [current, owned] = await Promise.all([
			stat(indexPath),
			stat(ownedIndex),
		]);
		if (current.dev === owned.dev && current.ino === owned.ino)
			await rm(ownedIndex);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	try {
		await writeFile(ownedIndex, "", { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	try {
		const [held, owned] = await Promise.all([stat(lock), stat(ownedIndex)]);
		if (held.dev !== owned.dev || held.ino !== owned.ino)
			throw new Error("Another Git operation owns the index lock.");
		await rm(lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await link(ownedIndex, lock);
	try {
		try {
			await copyFile(indexPath, lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await withTemporaryIndex(cwd, async (temporary) => {
				await git(cwd, ["read-tree", "--empty"], temporary);
				await writeFile(lock, await readFile(temporary));
			});
		}
		await withTemporaryIndex(cwd, async (temporary) => {
			const patchPath = await prepareRestorePatch(
				cwd,
				target,
				expected,
				temporary,
			);
			if (patchPath !== null)
				await git(cwd, ["apply", "--binary", "--whitespace=nowarn", patchPath]);
		});
		await withTemporaryIndex(cwd, async (temporary) => {
			await git(cwd, ["read-tree", target.indexTree], temporary);
			await writeFile(lock, await readFile(temporary));
		});
		await rename(lock, indexPath);
	} finally {
		await rm(lock, { force: true });
		await rm(ownedIndex, { force: true });
	}
};

/** Paths affected by a restore; NUL framing preserves whitespace and unusual filenames. */
export const checkpointChangedFiles = async (
	cwd: string,
	targetId: string,
	expectedId: string,
): Promise<readonly string[]> => {
	const target = await readGitCheckpoint(cwd, targetId);
	const expected = await readGitCheckpoint(cwd, expectedId);
	if (target === null || expected === null)
		throw new Error("Checkpoint is missing.");
	return (
		await git(target.root, [
			"diff",
			"--name-only",
			"-z",
			"--no-ext-diff",
			expected.tree,
			target.tree,
			"--",
		])
	)
		.split("\0")
		.filter(Boolean);
};
