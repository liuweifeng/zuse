import type { FsEntry } from "@zuse/contracts";

export type FileTreePathOperation =
	| { readonly type: "add"; readonly path: string }
	| { readonly type: "remove"; readonly path: string };

const stripSlash = (path: string): string => path.replace(/\/+$/u, "");

const parentPath = (path: string): string => {
	const normalized = stripSlash(path);
	const separator = normalized.lastIndexOf("/");
	return separator === -1 ? "" : normalized.slice(0, separator);
};

const treePath = (entry: FsEntry): string =>
	entry.kind === "directory" ? `${stripSlash(entry.path)}/` : entry.path;

/** Refresh one deferred level, preserving descendants of surviving directories. */
export const deferredDirectoryPaths = (
	knownPaths: ReadonlySet<string>,
	directory: string,
	entries: ReadonlyArray<FsEntry>,
): string[] => {
	const children = entries.map(treePath);
	const directories = new Set(children.filter((path) => path.endsWith("/")));
	const prefix = `${stripSlash(directory)}/`;
	return [
		...new Set([
			...[...knownPaths].filter(
				(path) =>
					!path.startsWith(prefix) ||
					path === prefix ||
					directories.has(path.slice(0, path.indexOf("/", prefix.length) + 1)),
			),
			...children,
		]),
	];
};

/**
 * Reconcile only directories touched by a filesystem watcher batch.
 *
 * New directories are walked only inside themselves. Deletes remove the
 * already-known subtree locally. Ordinary saves list just their parent.
 * Deferred directories (e.g. `node_modules`) are tracked but never walked;
 * the tree loads their contents only when the user expands them.
 */
export const reconcileFileTreePaths = async (input: {
	readonly changedPaths: ReadonlyArray<string>;
	readonly knownPaths: ReadonlySet<string>;
	readonly deferredDirectories?: ReadonlySet<string>;
	readonly listDirectory: (path: string) => Promise<ReadonlyArray<FsEntry>>;
	readonly maxDirectories?: number;
}): Promise<{
	readonly paths: ReadonlySet<string>;
	readonly deferredDirectories: ReadonlySet<string>;
	readonly operations: ReadonlyArray<FileTreePathOperation>;
	readonly requiresFullReconciliation: boolean;
}> => {
	const next = new Set(input.knownPaths);
	const deferred = new Set(input.deferredDirectories);
	const operations: FileTreePathOperation[] = [];
	const queued = new Set<string>();
	const pending: string[] = [];
	const maxDirectories = input.maxDirectories ?? 2_000;
	const childrenByParent = new Map<string, Set<string>>();

	const indexPath = (path: string): void => {
		const parent = parentPath(path);
		const siblings = childrenByParent.get(parent) ?? new Set<string>();
		siblings.add(path);
		childrenByParent.set(parent, siblings);
	};
	for (const path of next) indexPath(path);

	const removeSubtree = (path: string): void => {
		for (const child of [...(childrenByParent.get(stripSlash(path)) ?? [])]) {
			removeSubtree(child);
		}
		childrenByParent.delete(stripSlash(path));
		childrenByParent.get(parentPath(path))?.delete(path);
		deferred.delete(stripSlash(path));
		if (!next.delete(path)) return;
		operations.push({ type: "remove", path });
	};

	const enqueue = (path: string): void => {
		const normalized = stripSlash(path);
		if (queued.has(normalized) || deferred.has(normalized)) return;
		queued.add(normalized);
		pending.push(normalized);
	};

	for (const changedPath of input.changedPaths) {
		enqueue(parentPath(changedPath));
		if (next.has(`${stripSlash(changedPath)}/`)) enqueue(changedPath);
	}

	pending.sort();

	let processed = 0;
	while (pending.length > 0) {
		const directory = pending.shift() ?? "";
		if (
			directory !== "" &&
			input.knownPaths.has(`${directory}/`) &&
			!next.has(`${directory}/`)
		)
			continue;
		if (processed >= maxDirectories) {
			return {
				paths: input.knownPaths,
				deferredDirectories: input.deferredDirectories ?? new Set(),
				operations: [],
				requiresFullReconciliation: true,
			};
		}
		processed += 1;
		const entries = await input.listDirectory(directory);

		const serverChildren = new Map(
			entries.map((entry) => [treePath(entry), entry] as const),
		);
		for (const existing of [
			...(childrenByParent.get(stripSlash(directory)) ?? []),
		]) {
			if (serverChildren.has(existing)) continue;
			removeSubtree(existing);
		}

		for (const [path, entry] of serverChildren) {
			const added = !next.has(path);
			if (added) {
				next.add(path);
				indexPath(path);
				operations.push({ type: "add", path });
			}
			if (entry.kind === "directory" && entry.deferred === true) {
				deferred.add(stripSlash(entry.path));
			} else if (entry.kind === "directory" && added) {
				enqueue(entry.path);
			}
		}
	}

	return {
		paths: next,
		deferredDirectories: deferred,
		operations,
		requiresFullReconciliation: false,
	};
};

/** Translate canonical snapshots into mutations without resetting tree UI state. */
export const fileTreeSnapshotOperations = (
	knownPaths: ReadonlySet<string>,
	paths: ReadonlyArray<string>,
): FileTreePathOperation[] => {
	const next = new Set(paths);

	return [
		...[...knownPaths]
			.filter((path) => !next.has(path))
			.sort((a, b) => b.length - a.length)
			.map((path) => ({ type: "remove" as const, path })),
		...paths
			.filter((path) => !knownPaths.has(path))
			.map((path) => ({ type: "add" as const, path })),
	];
};
