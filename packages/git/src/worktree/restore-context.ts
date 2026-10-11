import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const fingerprint = async (path: string): Promise<string> => {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
};

/** Merge checkpoint-materialized context without overwriting either version.
 * The archived directory remains intact; the caller cleans it up only after
 * the restored worktree is durably committed. Conflicting files fail before any mutation; the caller can then
 * remove its disposable checkout while retaining the archive and Git snapshot.
 */
export const mergeArchivedContext = async (
	archived: string,
	restored: string,
): Promise<void> => {
	const copies: Array<{ source: string; destination: string }> = [];
	const inspect = async (
		source: string,
		destination: string,
	): Promise<void> => {
		const sourceStat = await lstat(source);
		const destinationStat = await lstat(destination).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return null;
			throw error;
		});
		if (destinationStat === null) {
			copies.push({ source, destination });
			return;
		}
		if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
			for (const name of await readdir(source))
				await inspect(join(source, name), join(destination, name));
			return;
		}
		if (
			sourceStat.isFile() &&
			destinationStat.isFile() &&
			sourceStat.size === destinationStat.size &&
			(await fingerprint(source)) === (await fingerprint(destination))
		)
			return;
		if (
			sourceStat.isSymbolicLink() &&
			destinationStat.isSymbolicLink() &&
			(await readlink(source)) === (await readlink(destination))
		)
			return;
		throw new Error(`Context restore conflict: ${destination}`);
	};
	await inspect(archived, restored);
	for (const { source, destination } of copies)
		await cp(source, destination, {
			recursive: true,
			force: false,
			errorOnExist: true,
			verbatimSymlinks: true,
		});
};
