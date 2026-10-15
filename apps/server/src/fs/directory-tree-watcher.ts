import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";

export type DirectoryTreeWatcher = {
	readonly close: () => void;
};

export type DirectoryTreeWatcherOptions = {
	readonly root: string;
	/**
	 * Whether a directory's contents stay unwatched. `rel` is root-relative and
	 * forward-slash. The directory itself is still reported by its parent, so
	 * it can appear and disappear in the tree without its subtree being crawled.
	 */
	readonly isExcludedDirectory: (rel: string, name: string) => boolean;
	/** Re-reads exclusion inputs (e.g. `.gitignore`) before a new directory is judged. */
	readonly refreshExclusions: () => Promise<void>;
	readonly onChange: (rel: string) => void;
	readonly onError: (error: Error) => void;
};

const joinRel = (parent: string, name: string): string =>
	parent === "" ? name : `${parent}/${name}`;

const toForwardSlash = (p: string): string =>
	path.sep === "/" ? p : p.split(path.sep).join("/");

const insideExcludedDirectory = (
	rel: string,
	isExcludedDirectory: DirectoryTreeWatcherOptions["isExcludedDirectory"],
): boolean => {
	const segments = rel.split("/");
	let prefix = "";
	for (const segment of segments.slice(0, -1)) {
		prefix = joinRel(prefix, segment);
		if (isExcludedDirectory(prefix, segment)) return true;
	}
	return false;
};

/**
 * Native recursive watching is kernel-backed on macOS and Windows. Linux has
 * no recursive inotify, and Node emulates it by crawling and watching every
 * directory — including `node_modules` and `.git` — which exhausts the
 * inotify limit on real projects. There we watch only included directories.
 */
const watchRecursively = (
	options: DirectoryTreeWatcherOptions,
): DirectoryTreeWatcher => {
	const handle = watch(
		options.root,
		{ recursive: true },
		(_event, filename) => {
			if (filename === null) return;
			const rel = toForwardSlash(filename.toString());
			if (
				rel === "" ||
				insideExcludedDirectory(rel, options.isExcludedDirectory)
			)
				return;
			options.onChange(rel);
		},
	);
	handle.on("error", options.onError);
	return { close: () => handle.close() };
};

const watchPerDirectory = async (
	options: DirectoryTreeWatcherOptions,
): Promise<DirectoryTreeWatcher> => {
	const watchers = new Map<string, FSWatcher>();
	let closed = false;
	let reportedLimit = false;

	const detach = (rel: string): void => {
		for (const [watchedRel, watcher] of watchers) {
			if (
				watchedRel === rel ||
				rel === "" ||
				watchedRel.startsWith(`${rel}/`)
			) {
				watcher.close();
				watchers.delete(watchedRel);
			}
		}
	};

	const attach = async (
		rel: string,
		reportExisting: boolean,
	): Promise<void> => {
		if (closed || watchers.has(rel)) return;
		const abs = rel === "" ? options.root : path.join(options.root, rel);
		let watcher: FSWatcher;
		try {
			watcher = watch(abs, (event, filename) => {
				if (filename === null) return;
				const childRel = joinRel(rel, toForwardSlash(filename.toString()));
				options.onChange(childRel);
				if (event === "rename") void syncChild(childRel);
			});
		} catch (error) {
			if (rel === "") throw error;
			if (
				(error as NodeJS.ErrnoException).code === "ENOSPC" &&
				!reportedLimit
			) {
				reportedLimit = true;
				console.warn(
					`[fs.watchTree] inotify watch limit reached under ${options.root}; some directories are not watched`,
				);
			}
			return;
		}
		watcher.on("error", (error) => {
			if (rel !== "") detach(rel);
			options.onError(error);
		});
		watchers.set(rel, watcher);
		const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
		if (reportExisting) {
			for (const entry of entries) options.onChange(joinRel(rel, entry.name));
		}
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => joinRel(rel, entry.name))
				.filter(
					(childRel) =>
						!options.isExcludedDirectory(
							childRel,
							path.posix.basename(childRel),
						),
				)
				.map((childRel) => attach(childRel, reportExisting)),
		);
	};

	const syncChild = async (childRel: string): Promise<void> => {
		const isDirectory = await stat(path.join(options.root, childRel)).then(
			(value) => value.isDirectory(),
			() => false,
		);
		if (closed) return;
		if (!isDirectory) {
			detach(childRel);
			return;
		}
		if (watchers.has(childRel)) return;
		await options.refreshExclusions().catch(() => undefined);
		if (
			closed ||
			options.isExcludedDirectory(childRel, path.posix.basename(childRel))
		)
			return;
		await attach(childRel, true);
	};

	await attach("", false);
	return {
		close: () => {
			closed = true;
			detach("");
		},
	};
};

/**
 * Watches `root` for changes outside excluded directories. Resolves once every
 * included directory is watched, so a snapshot read afterwards cannot miss a
 * change. Throws when the root itself cannot be watched.
 */
export const watchDirectoryTree = (
	options: DirectoryTreeWatcherOptions,
): Promise<DirectoryTreeWatcher> =>
	process.platform === "linux"
		? watchPerDirectory(options)
		: Promise.resolve().then(() => watchRecursively(options));
