import * as path from "node:path";
import {
	DirectoryUnavailableError,
	FsFolderNotFoundError,
} from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { Effect, FileSystem, Layer, Path } from "effect";
import fuzzysort from "fuzzysort";
import {
	type FileSearchHit,
	FileSearchService,
	type FileSearchServiceShape,
} from "../services/file-search.ts";
import { WorkspaceService } from "../services/workspace-service.ts";

const SKIP_DIRS = new Set([
	".git",
	"node_modules",

	".zuse",
	"dist",
	"build",
	".turbo",
	".next",
	".vite",
	".cache",
	".DS_Store",
]);

const MAX_DEPTH = 12;

const MAX_VISITED = 20_000;

const DEFAULT_LIMIT = 20;

const toForwardSlash = (p: string): string =>
	path.sep === "/" ? p : p.split(path.sep).join("/");

export const FileSearchServiceLive = Layer.effect(
	FileSearchService,
	Effect.gen(function* () {
		const workspace = yield* WorkspaceService;
		const worktrees = yield* WorktreeService;
		const git = yield* GitService;
		const fs = yield* FileSystem.FileSystem;
		const pathSvc = yield* Path.Path;

		const search: FileSearchServiceShape["search"] = (
			folderId,
			query,
			limit,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const folder = yield* workspace.findById(folderId);
				if (folder === null) {
					return yield* Effect.fail(new FsFolderNotFoundError({ folderId }));
				}
				const cap = limit && limit > 0 ? limit : DEFAULT_LIMIT;

				let root = folder.path;
				if (worktreeId) {
					const wt = yield* worktrees.get(worktreeId);
					if (wt === null || wt.projectId !== folderId) {
						return yield* Effect.fail(
							new DirectoryUnavailableError({
								folderId,
								worktreeId,
								reason: "worktree-missing",
							}),
						);
					}
					root = wt.path;
				}
				const rootExists = yield* fs
					.exists(root)
					.pipe(Effect.orElseSucceed(() => false));
				if (!rootExists) {
					return yield* Effect.fail(
						new DirectoryUnavailableError({
							folderId,
							worktreeId: worktreeId ?? null,
							reason: worktreeId ? "worktree-missing" : "project-missing",
						}),
					);
				}
				const rootAbs = pathSvc.resolve(root);
				const ignoredDirs = yield* git
					.ignoredDirectories(folderId, worktreeId)
					.pipe(Effect.orElseSucceed((): ReadonlySet<string> => new Set()));

				const candidates: FileSearchHit[] = [];
				let visited = 0;

				const walk = (
					absDir: string,
					relDir: string,
					depth: number,
				): Effect.Effect<void> =>
					Effect.gen(function* () {
						if (visited >= MAX_VISITED) return;
						if (depth > MAX_DEPTH) return;

						const names = yield* fs
							.readDirectory(absDir)
							.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

						const sorted = [...names].sort((a, b) =>
							a.localeCompare(b, undefined, { sensitivity: "base" }),
						);

						for (const name of sorted) {
							if (visited >= MAX_VISITED) return;
							if (SKIP_DIRS.has(name)) continue;

							visited++;
							const childAbs = pathSvc.join(absDir, name);
							const childRel = relDir === "" ? name : `${relDir}/${name}`;

							const stat = yield* fs.stat(childAbs).pipe(Effect.option);
							if (stat._tag === "None") continue;
							const kind =
								stat.value.type === "Directory" ? "directory" : "file";
							if (
								kind === "directory" &&
								ignoredDirs.has(toForwardSlash(childRel))
							)
								continue;

							candidates.push({
								relPath: toForwardSlash(childRel),
								absPath: childAbs,
								kind,
							});

							if (kind === "directory") {
								yield* walk(childAbs, childRel, depth + 1);
							}
						}
					});

				yield* walk(rootAbs, "", 0);

				if (!query) return candidates.slice(0, cap);

				const ranked = fuzzysort.go(query, candidates, {
					key: "relPath",
					limit: cap,
					threshold: 0.3,
				});
				return ranked.map((r) => r.obj);
			});

		return { search } satisfies FileSearchServiceShape;
	}),
);
