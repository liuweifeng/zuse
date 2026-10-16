import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import {
	DirectoryUnavailableError,
	type FolderId,
	FsAlreadyExistsError,
	FsCommandReuseError,
	FsConflictError,
	FsEntry,
	FsExternalConflictError,
	FsExternalReadError,
	FsExternalTooLargeError,
	FsFolderNotFoundError,
	FsPathOutsideError,
	FsReadError,
	FsTooLargeError,
	FsTreeWatchEvent,
	type WorktreeId,
} from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, FileSystem, Layer, Option, Path, Queue, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { WorkspaceFileAccess } from "../../collaboration/services/workspace-file-access.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { watchDirectoryTree } from "../directory-tree-watcher.ts";
import { FsService } from "../services/fs-service.ts";

const SKIP_DIRS = new Set([".git", ".zuse", ".DS_Store"]);

const DEFERRED_DIR_NAMES = new Set(["node_modules"]);
const WATCH_BATCH_MS = 120;

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const MAX_TREE_PATHS = 50_000;

const MAX_TREE_PATH_BYTES = 900 * 1024;
const FS_WRITE_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_APPLIED_FS_WRITE_RECEIPTS = 10_000;

type FsWriteReceipt = {
	readonly folder_id: string;
	readonly worktree_id: string | null;
	readonly path: string;
	readonly expected_mtime: string;
	readonly content_hash: string;
	readonly state: "prepared" | "applied";
	readonly mtime: string | null;
};

type TreeWatchState = {
	readonly epoch: string;
	sequence: number;
};

const toForwardSlash = (p: string): string =>
	path.sep === "/" ? p : p.split(path.sep).join("/");

const isDeferredPath = (
	rel: string,
	ignoredDirs: ReadonlySet<string>,
): boolean => {
	let prefix = "";
	for (const segment of rel.split("/")) {
		prefix = prefix === "" ? segment : `${prefix}/${segment}`;
		if (DEFERRED_DIR_NAMES.has(segment) || ignoredDirs.has(prefix)) return true;
	}
	return false;
};

const mtimeToString = (mtime: Option.Option<Date>): string =>
	Option.match(mtime, {
		onNone: () => "",
		onSome: (d) => d.toISOString(),
	});

const sha256 = (value: string | Uint8Array): string =>
	createHash("sha256").update(value).digest("hex");

export const FsServiceLive = Layer.effect(
	FsService,
	Effect.gen(function* () {
		const workspace = yield* WorkspaceService;
		const worktrees = yield* WorktreeService;
		const git = yield* GitService;
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const pathSvc = yield* Path.Path;
		const writeSerial = new KeyedEffectSerialWorker<string>();
		const isInsideRoot = (root: string, target: string) => {
			const relative = pathSvc.relative(root, target);
			return (
				relative !== ".." &&
				!relative.startsWith(`..${pathSvc.sep}`) &&
				!pathSvc.isAbsolute(relative)
			);
		};
		const redactReadError = (error: FsReadError) =>
			Effect.serviceOption(WorkspaceFileAccess).pipe(
				Effect.flatMap((access) =>
					Effect.fail(
						Option.isNone(access)
							? error
							: new FsReadError({
									folderId: error.folderId,
									path: error.path,
									reason: "File is unavailable",
								}),
					),
				),
			);
		const readEntry = Effect.fn("FsService.readEntry")(function* (
			root: string,
			entry: string,
			scoped: boolean,
		) {
			const resolved = scoped
				? yield* fs.realPath(entry).pipe(Effect.option)
				: Option.some(entry);
			if (
				Option.isNone(resolved) ||
				(scoped && !isInsideRoot(root, resolved.value))
			)
				return null;
			const stat = yield* fs.stat(resolved.value).pipe(Effect.option);
			if (
				Option.isNone(stat) ||
				(scoped &&
					stat.value.type !== "File" &&
					stat.value.type !== "Directory")
			)
				return null;
			return { abs: resolved.value, stat: stat.value };
		});
		const visibleWatchPath = Effect.fn("FsService.visibleWatchPath")(function* (
			root: string,
			rel: string,
		) {
			if (pathSvc.isAbsolute(rel)) return null;
			let candidate = pathSvc.resolve(root, rel);
			if (!isInsideRoot(root, candidate)) return null;
			let changed = candidate;
			while (true) {
				const canonical = yield* fs.realPath(candidate).pipe(
					Effect.map((value) => ({ kind: "found" as const, value })),
					Effect.catch((error) =>
						Effect.succeed({
							kind:
								error.reason._tag === "NotFound"
									? ("missing" as const)
									: ("denied" as const),
						}),
					),
				);
				if (canonical.kind === "found")
					return isInsideRoot(root, canonical.value)
						? toForwardSlash(pathSvc.relative(root, changed))
						: null;
				if (canonical.kind === "denied" || candidate === root) return null;

				changed = candidate;
				candidate = pathSvc.dirname(candidate);
			}
		});

		const resolveInsideFolder = (
			folderId: FolderId,
			relPath: string,
			worktreeId?: WorktreeId | null,
		) =>
			Effect.gen(function* () {
				const access = yield* Effect.serviceOption(WorkspaceFileAccess);
				if (
					Option.isSome(access) &&
					(access.value.folderId !== folderId ||
						access.value.worktreeId !== (worktreeId ?? null))
				)
					return yield* new FsPathOutsideError({ folderId, path: relPath });
				const folder = yield* workspace.findById(folderId);
				if (folder === null) {
					return yield* Effect.fail(new FsFolderNotFoundError({ folderId }));
				}
				let rootPath = folder.path;
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
					rootPath = wt.path;
				}
				const rootExists = yield* fs
					.exists(rootPath)
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
				const rootAbs = pathSvc.resolve(rootPath);
				const requestedAbs = pathSvc.resolve(rootAbs, relPath);
				const rel = pathSvc.relative(rootAbs, requestedAbs);
				if (rel.startsWith("..") || pathSvc.isAbsolute(rel)) {
					return yield* Effect.fail(
						new FsPathOutsideError({ folderId, path: relPath }),
					);
				}
				if (Option.isSome(access)) {
					const canonical = yield* Effect.all({
						root: fs.realPath(rootAbs),
						requested: fs.realPath(requestedAbs),
					}).pipe(
						Effect.mapError(
							() =>
								new FsReadError({
									folderId,
									path: relPath,
									reason: "File is unavailable",
								}),
						),
					);
					if (!isInsideRoot(canonical.root, canonical.requested))
						return yield* new FsPathOutsideError({ folderId, path: relPath });

					return { rootAbs: canonical.root, requestedAbs: canonical.requested };
				}
				return { rootAbs, requestedAbs } as const;
			});

		const ignoredDirectories = (
			folderId: FolderId,
			worktreeId?: WorktreeId | null,
		): Effect.Effect<ReadonlySet<string>> =>
			git
				.ignoredDirectories(folderId, worktreeId)
				.pipe(Effect.orElseSucceed((): ReadonlySet<string> => new Set()));

		const tree: FsService["Service"]["tree"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const scoped = Option.isSome(
					yield* Effect.serviceOption(WorkspaceFileAccess),
				);
				const { rootAbs, requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);

				const ignoredDirs = yield* ignoredDirectories(folderId, worktreeId);
				const names = yield* fs.readDirectory(requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);

				const stats = yield* Effect.forEach(
					names,
					(name) =>
						Effect.gen(function* () {
							const entryAbs = pathSvc.join(requestedAbs, name);
							const entry = yield* readEntry(rootAbs, entryAbs, scoped);
							if (entry === null) return null;
							const kind =
								entry.stat.type === "Directory" ? "directory" : "file";
							if (kind === "directory" && SKIP_DIRS.has(name)) return null;
							const childRel = toForwardSlash(
								relPath === "" ? name : `${relPath}/${name}`,
							);
							return FsEntry.make({
								name,
								path: childRel,
								kind,
								...(kind === "directory" &&
								isDeferredPath(childRel, ignoredDirs)
									? { deferred: true }
									: {}),
							});
						}),
					{ concurrency: "unbounded" },
				);

				const entries = stats.filter((e): e is FsEntry => e !== null);

				entries.sort((a, b) => {
					if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
					return a.name.localeCompare(b.name, undefined, {
						sensitivity: "base",
					});
				});
				return entries;
			}).pipe(Effect.catchTag("FsReadError", redactReadError));

		const watchTree: FsService["Service"]["watchTree"] = (
			folderId,
			worktreeId,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const scoped = Option.isSome(
						yield* Effect.serviceOption(WorkspaceFileAccess),
					);
					const { rootAbs } = yield* resolveInsideFolder(
						folderId,
						"",
						worktreeId,
					);
					const queue = yield* Queue.unbounded<FsTreeWatchEvent>();
					const state: TreeWatchState = { epoch: randomUUID(), sequence: 0 };
					const publish = (event: FsTreeWatchEvent): void => {
						Queue.offerUnsafe(queue, event);
					};

					let timer: ReturnType<typeof setTimeout> | null = null;
					const pending = new Set<string>();
					let ignoredDirs = yield* ignoredDirectories(folderId, worktreeId);
					let handle: Awaited<ReturnType<typeof watchDirectoryTree>> | null =
						null;

					yield* Effect.addFinalizer(() =>
						Effect.andThen(
							Effect.sync(() => {
								if (timer !== null) {
									clearTimeout(timer);
									timer = null;
								}
								handle?.close();
							}),
							Queue.shutdown(queue),
						),
					);

					const flush = () => {
						timer = null;
						if (pending.size === 0) return;
						const paths = Array.from(pending);
						pending.clear();
						state.sequence += 1;
						publish(
							FsTreeWatchEvent.make({
								_tag: "changed",
								epoch: state.epoch,
								sequence: state.sequence,
								paths,
							}),
						);
					};

					const schedule = () => {
						if (timer === null) timer = setTimeout(flush, WATCH_BATCH_MS);
					};

					const attached = yield* Effect.tryPromise({
						try: () =>
							watchDirectoryTree({
								root: rootAbs,
								isExcludedDirectory: (rel, name) =>
									SKIP_DIRS.has(name) || isDeferredPath(rel, ignoredDirs),
								refreshExclusions: () =>
									Effect.runPromise(
										ignoredDirectories(folderId, worktreeId),
									).then((next) => {
										ignoredDirs = next;
									}),
								onChange: (rel) => {
									if (rel.split("/").some((segment) => SKIP_DIRS.has(segment)))
										return;
									pending.add(rel);
									schedule();
								},
								onError: (err) => {
									console.warn("[fs.watchTree] fs.watch error:", err.message);
									state.sequence += 1;
									publish(
										FsTreeWatchEvent.make({
											_tag: "gap",
											epoch: state.epoch,
											sequence: state.sequence,
											reason: err.message,
										}),
									);
								},
							}),
						catch: (err) =>
							err instanceof Error ? err : new Error(String(err)),
					}).pipe(Effect.result);
					if (attached._tag === "Failure") {
						console.warn(
							`[fs.watchTree] could not watch ${rootAbs}: ${attached.failure.message}`,
						);
						return yield* Effect.fail(
							new FsReadError({
								folderId,
								path: "",
								reason: attached.failure.message,
							}),
						);
					}
					handle = attached.success;
					Queue.offerUnsafe(
						queue,
						FsTreeWatchEvent.make({
							_tag: "ready",
							epoch: state.epoch,
							sequence: state.sequence,
						}),
					);

					const events = Stream.fromQueue(queue);
					if (!scoped) return events;
					let visibleSequence = 0;
					return events.pipe(
						Stream.mapEffect((event): Effect.Effect<FsTreeWatchEvent> => {
							if (event._tag === "ready") return Effect.succeed(event);
							if (event._tag === "gap")
								return Effect.succeed({
									...event,
									reason: "File watcher continuity lost",
								});
							return Effect.forEach(
								event.paths,
								(rel) => visibleWatchPath(rootAbs, rel),
								{ concurrency: 8 },
							).pipe(
								Effect.map((paths) => ({
									...event,
									paths: [
										...new Set(
											paths.filter((path): path is string => path !== null),
										),
									],
								})),
							);
						}),
						Stream.filter(
							(event) => event._tag !== "changed" || event.paths.length > 0,
						),

						Stream.map((event) => ({
							...event,
							sequence:
								event._tag === "ready" ? visibleSequence : ++visibleSequence,
						})),
					);
				}).pipe(Effect.catchTag("FsReadError", redactReadError)),
			);

		const listPaths: FsService["Service"]["listPaths"] = (
			folderId,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const scoped = Option.isSome(
					yield* Effect.serviceOption(WorkspaceFileAccess),
				);
				const { rootAbs } = yield* resolveInsideFolder(
					folderId,
					"",
					worktreeId,
				);
				const ignoredDirs = yield* ignoredDirectories(folderId, worktreeId);
				const out: string[] = [];
				const deferredDirectories: string[] = [];
				let truncated = false;
				let estimatedBytes = 0;
				const ancestors = new Set<string>();

				const walk = (
					absDir: string,
					relDir: string,
				): Effect.Effect<void, FsReadError> =>
					Effect.gen(function* () {
						if (truncated) return;
						ancestors.add(absDir);
						const names = yield* fs.readDirectory(absDir).pipe(
							Effect.mapError(
								(cause) =>
									new FsReadError({
										folderId,
										path: relDir,
										reason: cause.message ?? String(cause),
									}),
							),
						);
						const rows = yield* Effect.forEach(
							names,
							(name) =>
								Effect.gen(function* () {
									const entryAbs = pathSvc.join(absDir, name);
									const entry = yield* readEntry(rootAbs, entryAbs, scoped);
									if (entry === null) return null;
									const kind =
										entry.stat.type === "Directory" ? "directory" : "file";
									if (kind === "directory" && SKIP_DIRS.has(name)) return null;
									const rel = toForwardSlash(
										relDir === "" ? name : `${relDir}/${name}`,
									);
									const deferred =
										kind === "directory" && isDeferredPath(rel, ignoredDirs);
									return { name, kind, abs: entry.abs, rel, deferred } as const;
								}),
							{ concurrency: "unbounded" },
						);
						const valid = rows.filter(
							(r): r is NonNullable<typeof r> => r !== null,
						);
						valid.sort((a, b) => {
							if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
							return a.name.localeCompare(b.name, undefined, {
								sensitivity: "base",
							});
						});
						for (const row of valid) {
							if (out.length >= MAX_TREE_PATHS) {
								truncated = true;
								return;
							}
							const renderedPath =
								row.kind === "directory" ? `${row.rel}/` : row.rel;
							const renderedBytes = Buffer.byteLength(renderedPath) + 3;
							if (estimatedBytes + renderedBytes > MAX_TREE_PATH_BYTES) {
								truncated = true;
								return;
							}
							estimatedBytes += renderedBytes;
							if (row.deferred) {
								out.push(renderedPath);
								deferredDirectories.push(row.rel);
							} else if (row.kind === "directory") {
								out.push(renderedPath);
								if (!scoped || !ancestors.has(row.abs))
									yield* walk(row.abs, row.rel);
								if (truncated) return;
							} else {
								out.push(renderedPath);
							}
						}
					}).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								ancestors.delete(absDir);
							}),
						),
					);

				yield* walk(rootAbs, "");
				return {
					paths: out,
					deferredDirectories,
					truncated,
				};
			}).pipe(Effect.catchTag("FsReadError", redactReadError));

		const move: FsService["Service"]["move"] = (
			folderId,
			fromPath,
			toPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const from = yield* resolveInsideFolder(folderId, fromPath, worktreeId);
				const to = yield* resolveInsideFolder(folderId, toPath, worktreeId);
				const destExists = yield* fs.stat(to.requestedAbs).pipe(Effect.option);
				if (destExists._tag === "Some") {
					return yield* Effect.fail(
						new FsAlreadyExistsError({ folderId, path: toPath }),
					);
				}
				yield* fs.rename(from.requestedAbs, to.requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: fromPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return {};
			});

		const readFile: FsService["Service"]["readFile"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const access = yield* Effect.serviceOption(WorkspaceFileAccess);
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);

				const stat = yield* fs.stat(requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				if (Option.isSome(access) && stat.type !== "File")
					return yield* new FsReadError({
						folderId,
						path: relPath,
						reason: "Not a regular file",
					});
				const size = Number(stat.size);
				if (size > MAX_FILE_BYTES) {
					return yield* Effect.fail(
						new FsTooLargeError({
							folderId,
							path: relPath,
							size,
							limit: MAX_FILE_BYTES,
						}),
					);
				}

				const bytes = yield* fs.readFile(requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);

				try {
					const decoder = new TextDecoder("utf-8", { fatal: true });
					const content = decoder.decode(bytes);
					return {
						kind: "text" as const,
						content,
						mtime: mtimeToString(stat.mtime),
						size,
					};
				} catch {
					return { kind: "binary" as const, bytes, size };
				}
			}).pipe(Effect.catchTag("FsReadError", redactReadError));

		const writeFile: FsService["Service"]["writeFile"] = (
			commandId,
			folderId,
			relPath,
			content,
			expectedMtime,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const byteLen = new TextEncoder().encode(content).byteLength;
				if (byteLen > MAX_FILE_BYTES) {
					return yield* Effect.fail(
						new FsTooLargeError({
							folderId,
							path: relPath,
							size: byteLen,
							limit: MAX_FILE_BYTES,
						}),
					);
				}
				const normalizedPath = toForwardSlash(path.normalize(relPath));
				const contentHash = sha256(content);
				const worktreeIdentity = worktreeId ?? null;
				const logicalTarget = `${folderId}\0${worktreeIdentity ?? ""}\0${normalizedPath}`;

				return yield* writeSerial.run(
					logicalTarget,
					Effect.gen(function* () {
						const now = Date.now();
						const receipt = yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`
									DELETE FROM fs_write_receipts
									WHERE updated_at < ${now - FS_WRITE_RECEIPT_RETENTION_MS}
								`.pipe(Effect.orDie);
								yield* sql`
									DELETE FROM fs_write_receipts
									WHERE command_id IN (
										SELECT command_id FROM fs_write_receipts
										WHERE state = 'applied'
										ORDER BY updated_at DESC
										LIMIT -1 OFFSET ${MAX_APPLIED_FS_WRITE_RECEIPTS}
									)
								`.pipe(Effect.orDie);
								yield* sql`
									INSERT OR IGNORE INTO fs_write_receipts
										(command_id, folder_id, worktree_id, path, expected_mtime,
										 content_hash, state, mtime, created_at, updated_at)
									VALUES
										(${commandId}, ${folderId}, ${worktreeIdentity},
										 ${normalizedPath}, ${expectedMtime}, ${contentHash},
										 'prepared', NULL, ${now}, ${now})
								`.pipe(Effect.orDie);
								const rows = yield* sql<FsWriteReceipt>`
									SELECT folder_id, worktree_id, path, expected_mtime,
										content_hash, state, mtime
									FROM fs_write_receipts
									WHERE command_id = ${commandId}
									LIMIT 1
								`.pipe(Effect.orDie);
								return rows[0];
							}),
						);
						if (receipt === undefined) {
							return yield* Effect.die(
								`File command ${commandId} was not persisted`,
							);
						}
						const targetMatches =
							receipt.folder_id === folderId &&
							receipt.worktree_id === worktreeIdentity &&
							receipt.path === normalizedPath;
						if (!targetMatches) {
							return yield* Effect.fail(
								new FsCommandReuseError({
									commandId,
									reason: "target-mismatch",
								}),
							);
						}
						if (
							receipt.expected_mtime !== expectedMtime ||
							receipt.content_hash !== contentHash
						) {
							return yield* Effect.fail(
								new FsCommandReuseError({
									commandId,
									reason: "payload-mismatch",
								}),
							);
						}
						if (receipt.state === "applied") {
							if (receipt.mtime === null) {
								return yield* Effect.die(
									`Applied file command ${commandId} has no mtime`,
								);
							}
							return { mtime: receipt.mtime };
						}
						const { requestedAbs } = yield* resolveInsideFolder(
							folderId,
							relPath,
							worktreeId,
						);

						const beforeStat = yield* fs.stat(requestedAbs).pipe(
							Effect.mapError(
								(cause) =>
									new FsReadError({
										folderId,
										path: relPath,
										reason: cause.message ?? String(cause),
									}),
							),
						);
						const actualMtime = mtimeToString(beforeStat.mtime);
						let contentAlreadyApplied = false;
						if (Number(beforeStat.size) === byteLen) {
							const bytes = yield* fs.readFile(requestedAbs).pipe(
								Effect.mapError(
									(cause) =>
										new FsReadError({
											folderId,
											path: relPath,
											reason: cause.message ?? String(cause),
										}),
								),
							);
							contentAlreadyApplied = sha256(bytes) === contentHash;
						}

						if (!contentAlreadyApplied && actualMtime !== expectedMtime) {
							return yield* Effect.fail(
								new FsConflictError({
									folderId,
									path: relPath,
									expectedMtime,
									actualMtime,
								}),
							);
						}

						let appliedMtime = actualMtime;
						if (!contentAlreadyApplied) {
							const temporary = pathSvc.join(
								pathSvc.dirname(requestedAbs),
								`.${pathSvc.basename(requestedAbs)}.zuse-write-${sha256(commandId).slice(0, 16)}`,
							);
							yield* Effect.acquireUseRelease(
								Effect.succeed(temporary),
								(tempPath) =>
									Effect.gen(function* () {
										yield* fs.writeFileString(tempPath, content);
										yield* fs.chmod(tempPath, beforeStat.mode);
										yield* fs.rename(tempPath, requestedAbs);
									}).pipe(
										Effect.mapError(
											(cause) =>
												new FsReadError({
													folderId,
													path: relPath,
													reason: cause.message ?? String(cause),
												}),
										),
									),
								(tempPath) =>
									fs.remove(tempPath, { force: true }).pipe(Effect.ignore),
							);
							const afterStat = yield* fs.stat(requestedAbs).pipe(
								Effect.mapError(
									(cause) =>
										new FsReadError({
											folderId,
											path: relPath,
											reason: cause.message ?? String(cause),
										}),
								),
							);
							appliedMtime = mtimeToString(afterStat.mtime);
						}

						return yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`
									UPDATE fs_write_receipts
									SET state = 'applied', mtime = ${appliedMtime},
										updated_at = ${Date.now()}
									WHERE command_id = ${commandId} AND state = 'prepared'
								`.pipe(Effect.orDie);
								const finalized = yield* sql<{ readonly mtime: string | null }>`
									SELECT mtime FROM fs_write_receipts
									WHERE command_id = ${commandId} AND state = 'applied'
									LIMIT 1
								`.pipe(Effect.orDie);
								const mtime = finalized[0]?.mtime;
								if (mtime === undefined || mtime === null) {
									return yield* Effect.die(
										`File command ${commandId} could not be finalized`,
									);
								}
								return { mtime };
							}),
						);
					}).pipe(Effect.catchTag("SqlError", Effect.die)),
				);
			});

		const createFile: FsService["Service"]["createFile"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);
				const existing = yield* fs.stat(requestedAbs).pipe(Effect.option);
				if (existing._tag === "Some") {
					return yield* Effect.fail(
						new FsAlreadyExistsError({ folderId, path: relPath }),
					);
				}
				yield* fs.writeFileString(requestedAbs, "").pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return {};
			});

		const createDirectory: FsService["Service"]["createDirectory"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);
				const existing = yield* fs.stat(requestedAbs).pipe(Effect.option);
				if (existing._tag === "Some") {
					return yield* Effect.fail(
						new FsAlreadyExistsError({ folderId, path: relPath }),
					);
				}
				yield* fs.makeDirectory(requestedAbs).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return {};
			});

		const remove: FsService["Service"]["remove"] = (
			folderId,
			relPath,
			worktreeId,
		) =>
			Effect.gen(function* () {
				const { requestedAbs } = yield* resolveInsideFolder(
					folderId,
					relPath,
					worktreeId,
				);
				yield* fs.remove(requestedAbs, { recursive: true }).pipe(
					Effect.mapError(
						(cause) =>
							new FsReadError({
								folderId,
								path: relPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return {};
			});

		const readExternal: FsService["Service"]["readExternal"] = (absPath) =>
			Effect.gen(function* () {
				const target = pathSvc.resolve(absPath);
				const stat = yield* fs.stat(target).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				const size = Number(stat.size);
				if (size > MAX_FILE_BYTES) {
					return yield* Effect.fail(
						new FsExternalTooLargeError({
							path: absPath,
							size,
							limit: MAX_FILE_BYTES,
						}),
					);
				}
				const bytes = yield* fs.readFile(target).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				try {
					const decoder = new TextDecoder("utf-8", { fatal: true });
					const content = decoder.decode(bytes);
					return {
						kind: "text" as const,
						content,
						mtime: mtimeToString(stat.mtime),
						size,
					};
				} catch {
					return { kind: "binary" as const, bytes, size };
				}
			});

		const writeExternal: FsService["Service"]["writeExternal"] = (
			absPath,
			content,
			expectedMtime,
		) =>
			Effect.gen(function* () {
				const target = pathSvc.resolve(absPath);
				const byteLen = new TextEncoder().encode(content).byteLength;
				if (byteLen > MAX_FILE_BYTES) {
					return yield* Effect.fail(
						new FsExternalTooLargeError({
							path: absPath,
							size: byteLen,
							limit: MAX_FILE_BYTES,
						}),
					);
				}
				const beforeStat = yield* fs.stat(target).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				const actualMtime = mtimeToString(beforeStat.mtime);
				if (actualMtime !== expectedMtime) {
					return yield* Effect.fail(
						new FsExternalConflictError({
							path: absPath,
							expectedMtime,
							actualMtime,
						}),
					);
				}
				yield* fs.writeFileString(target, content).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				const afterStat = yield* fs.stat(target).pipe(
					Effect.mapError(
						(cause) =>
							new FsExternalReadError({
								path: absPath,
								reason: cause.message ?? String(cause),
							}),
					),
				);
				return { mtime: mtimeToString(afterStat.mtime) };
			});

		return {
			tree,
			watchTree,
			listPaths,
			move,
			readFile,
			writeFile,
			createFile,
			createDirectory,
			remove,
			readExternal,
			writeExternal,
		} as const;
	}),
);
