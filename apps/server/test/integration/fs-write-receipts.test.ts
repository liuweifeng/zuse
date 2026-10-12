import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
	CommandId,
	Folder,
	FolderId,
	FsCommandReuseError,
	type FsTreeWatchEvent,
} from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Fiber, Layer, ManagedRuntime, Result, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceFileAccess } from "../../src/collaboration/services/workspace-file-access.ts";
import { FsServiceLive } from "../../src/fs/layers/fs-service.ts";
import { FsService } from "../../src/fs/services/fs-service.ts";
import { Migration0048FsWriteReceipts } from "../../src/persistence/migrations/0048_fs_write_receipts.ts";
import { WorkspaceService } from "../../src/workspace/services/workspace-service.ts";

const folderId = FolderId.make("folder-1");
const hash = (content: string): string =>
	createHash("sha256").update(content).digest("hex");

const commandId = (value: string) => CommandId.make(value);

const makeRuntime = (
	root: string,
	ignoredDirectories: ReadonlySet<string> = new Set(),
) => {
	const SqlLive = sqliteLayer({ filename: ":memory:" });
	const WorkspaceLive = Layer.succeed(WorkspaceService, {
		add: () => Effect.die("not used"),
		createScratch: () => Effect.die("not used"),
		list: () => Effect.succeed([]),
		streamChanges: () => Stream.die("not used"),
		remove: () => Effect.die("not used"),
		getSelected: () => Effect.succeed(null),
		setSelected: () => Effect.void,
		findById: (requestedId) =>
			Effect.succeed(
				requestedId === folderId
					? Folder.make({
							id: folderId,
							path: root,
							name: "fixture",
							addedAt: new Date("2026-01-01T00:00:00.000Z"),
						})
					: null,
			),
	});
	const WorktreeLive = Layer.succeed(WorktreeService, {
		create: () => Effect.die("not used"),
		list: () => Effect.succeed([]),
		get: () => Effect.succeed(null),
		renameBranch: () => Effect.die("not used"),
		archive: () => Effect.die("not used"),
		remove: () => Effect.die("not used"),
		rerunSetup: () => Effect.die("not used"),
		setupStream: () => Stream.die("not used"),
		startRun: () => Effect.die("not used"),
		restore: () => Effect.die("not used"),
	});
	const GitLive = Layer.succeed(GitService, {
		ignoredDirectories: () => Effect.succeed(ignoredDirectories),
	} as unknown as GitService["Service"]);
	const Dependencies = Layer.mergeAll(
		SqlLive,
		NodeServices.layer,
		WorkspaceLive,
		WorktreeLive,
		GitLive,
	);
	return ManagedRuntime.make(
		Layer.mergeAll(
			Dependencies,
			FsServiceLive.pipe(Layer.provide(Dependencies)),
		),
	);
};

describe("filesystem service", () => {
	let root: string;
	let runtime: ReturnType<typeof makeRuntime>;

	beforeEach(async () => {
		root = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "zuse-fs-write-"));
		runtime = makeRuntime(root);
		await runtime.runPromise(Migration0048FsWriteReceipts);
	});

	afterEach(async () => {
		await runtime.dispose();
		await nodeFs.rm(root, { recursive: true, force: true });
	});

	it("contains teammate reads without changing local symlink behavior", async () => {
		const project = nodePath.join(root, "project");
		await nodeFs.mkdir(project);
		await nodeFs.writeFile(nodePath.join(root, "private.txt"), "private");
		await nodeFs.writeFile(nodePath.join(project, "shared.txt"), "shared");
		await nodeFs.symlink(
			"../private.txt",
			nodePath.join(project, "escape.txt"),
		);
		await nodeFs.symlink("shared.txt", nodePath.join(project, "inside.txt"));
		await nodeFs.symlink("..", nodePath.join(project, "outside"));
		await nodeFs.symlink(".", nodePath.join(project, "cycle"));
		await nodeFs.mkdir(nodePath.join(project, "nested"));
		await nodeFs.writeFile(
			nodePath.join(project, "nested", "child.txt"),
			"child",
		);
		await nodeFs.symlink("nested", nodePath.join(project, "alias"));
		const isolated = makeRuntime(project);
		const read = (path: string, shared = true, requestedId = folderId) => {
			const effect = Effect.flatMap(FsService, (service) =>
				service.readFile(requestedId, path),
			);
			return isolated.runPromise(
				shared
					? effect.pipe(
							Effect.provideService(WorkspaceFileAccess, {
								folderId,
								worktreeId: null,
							}),
						)
					: effect,
			);
		};
		try {
			const browse = <A, E>(effect: Effect.Effect<A, E, FsService>) =>
				isolated.runPromise(
					effect.pipe(
						Effect.provideService(WorkspaceFileAccess, {
							folderId,
							worktreeId: null,
						}),
					),
				);
			const entries = await browse(
				Effect.flatMap(FsService, (service) => service.tree(folderId, "")),
			);
			expect(entries.map((entry) => entry.name)).toEqual([
				"alias",
				"cycle",
				"nested",
				"inside.txt",
				"shared.txt",
			]);
			const paths = await browse(
				Effect.flatMap(FsService, (service) => service.listPaths(folderId)),
			);
			expect(paths).toEqual({
				deferredDirectories: [],
				paths: [
					"alias/",
					"alias/child.txt",
					"cycle/",
					"nested/",
					"nested/child.txt",
					"inside.txt",
					"shared.txt",
				],
				truncated: false,
			});
			await expect(
				browse(
					Effect.flatMap(FsService, (service) =>
						service.tree(folderId, "outside"),
					),
				),
			).rejects.toMatchObject({ _tag: "FsPathOutsideError" });
			await expect(
				browse(
					Effect.flatMap(FsService, (service) =>
						service.tree(folderId, "missing"),
					),
				),
			).rejects.toMatchObject({
				_tag: "FsReadError",
				reason: "File is unavailable",
			});
			await expect(read("shared.txt")).resolves.toMatchObject({
				kind: "text",
				content: "shared",
			});
			await expect(read("inside.txt")).resolves.toMatchObject({
				kind: "text",
				content: "shared",
			});
			await expect(read("escape.txt", false)).resolves.toMatchObject({
				kind: "text",
				content: "private",
			});
			for (const path of [
				"escape.txt",
				"outside/private.txt",
				"../private.txt",
				nodePath.join(root, "private.txt"),
			]) {
				await expect(read(path)).rejects.toMatchObject({
					_tag: "FsPathOutsideError",
				});
			}
			await expect(
				read("shared.txt", true, FolderId.make("other")),
			).rejects.toMatchObject({ _tag: "FsPathOutsideError" });
			for (const path of ["missing.txt", "."]) {
				await expect(read(path)).rejects.toMatchObject({
					_tag: "FsReadError",
					reason: "File is unavailable",
				});
			}
		} finally {
			await isolated.dispose();
		}
	});

	it("keeps shared watcher paths contained and reports deletions with contiguous cursors", async () => {
		const project = nodePath.join(root, "project");
		const outside = nodePath.join(root, "private");
		await nodeFs.mkdir(project);
		await nodeFs.mkdir(outside);
		await nodeFs.writeFile(nodePath.join(project, "delete.txt"), "before");
		await nodeFs.symlink(outside, nodePath.join(project, "outside"));
		const isolated = makeRuntime(project);
		const events: FsTreeWatchEvent[] = [];
		const fiber = isolated.runFork(
			Effect.gen(function* () {
				const service = yield* FsService;
				yield* Stream.runForEach(service.watchTree(folderId), (event) =>
					Effect.sync(() => {
						events.push(event);
					}),
				);
			}).pipe(
				Effect.provideService(WorkspaceFileAccess, {
					folderId,
					worktreeId: null,
				}),
			),
		);
		const changed = () =>
			events.flatMap((event) => (event._tag === "changed" ? event.paths : []));
		try {
			await expect.poll(() => events[0]?._tag).toBe("ready");
			await nodeFs.writeFile(nodePath.join(outside, "secret.txt"), "private");
			await nodeFs.writeFile(nodePath.join(project, "shared.txt"), "shared");
			await expect.poll(changed).toContain("shared.txt");
			await nodeFs.unlink(nodePath.join(project, "delete.txt"));
			await expect.poll(changed).toContain("delete.txt");
			expect(changed().some((path) => path.includes("secret"))).toBe(false);
			expect(events.map((event) => event.sequence)).toEqual(
				events.map((_, index) => index),
			);
			expect(new Set(events.map((event) => event.epoch)).size).toBe(1);
			await isolated.runPromise(Fiber.interrupt(fiber));
			const restarted = await isolated.runPromise(
				Effect.flatMap(FsService, (service) =>
					Stream.runCollect(
						service.watchTree(folderId).pipe(
							Stream.take(1),
							Stream.provideService(WorkspaceFileAccess, {
								folderId,
								worktreeId: null,
							}),
						),
					),
				),
			);
			expect(restarted[0]).toMatchObject({ _tag: "ready", sequence: 0 });
			expect(restarted[0]?.epoch).not.toBe(events[0]?.epoch);
		} finally {
			await isolated.runPromise(Fiber.interrupt(fiber));
			await isolated.dispose();
		}
	});

	it("reports change batches before continuous editing stops", async () => {
		const events: string[] = [];
		const fiber = runtime.runFork(
			Effect.gen(function* () {
				const fs = yield* FsService;
				yield* Stream.runForEach(fs.watchTree(folderId, null), (event) =>
					Effect.sync(() => {
						events.push(event._tag);
					}),
				);
			}),
		);
		try {
			await new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + 2_000;
				const check = () => {
					if (events.includes("ready")) resolve();
					else if (Date.now() > deadline)
						reject(new Error("Watcher did not become ready"));
					else setTimeout(check, 10);
				};
				check();
			});
			// Write faster than the frame window for several windows; activity must not starve.
			for (let index = 0; index < 30; index++) {
				await nodeFs.writeFile(
					nodePath.join(root, "changing.txt"),
					String(index),
				);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(
				events.filter((tag) => tag === "changed").length,
			).toBeGreaterThanOrEqual(2);
		} finally {
			await runtime.runPromise(Fiber.interrupt(fiber));
		}
	});

	it("creates the durable intent and identity columns", async () => {
		const columns = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ readonly name: string }>`
					PRAGMA table_info(fs_write_receipts)
				`;
			}),
		);

		expect(columns.map(({ name }) => name)).toEqual([
			"command_id",
			"folder_id",
			"worktree_id",
			"path",
			"expected_mtime",
			"content_hash",
			"state",
			"mtime",
			"created_at",
			"updated_at",
		]);
	});

	it("returns the stored receipt after a response is lost", async () => {
		const target = nodePath.join(root, "notes.txt");
		await nodeFs.writeFile(target, "before");
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "notes.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");
		const id = commandId("write-lost-response");
		const receipt = await runtime.runPromise(
			service.writeFile(id, folderId, "notes.txt", "accepted", initial.mtime),
		);

		await nodeFs.writeFile(target, "later external edit");
		const retried = await runtime.runPromise(
			service.writeFile(id, folderId, "notes.txt", "accepted", initial.mtime),
		);

		expect(retried).toEqual(receipt);
		expect(await nodeFs.readFile(target, "utf8")).toBe("later external edit");
	});

	it("finalizes a prepared receipt when the file write survived a crash", async () => {
		const target = nodePath.join(root, "crash.txt");
		await nodeFs.writeFile(target, "before");
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "crash.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");
		const id = commandId("write-crash-window");
		const desired = "content already replaced";

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const now = Date.now();
				yield* sql`
					INSERT INTO fs_write_receipts
						(command_id, folder_id, worktree_id, path, expected_mtime,
						 content_hash, state, mtime, created_at, updated_at)
					VALUES
						(${id}, ${folderId}, NULL, 'crash.txt', ${initial.mtime},
						 ${hash(desired)}, 'prepared', NULL, ${now}, ${now})
				`;
			}),
		);
		await nodeFs.writeFile(target, desired);

		const receipt = await runtime.runPromise(
			service.writeFile(id, folderId, "crash.txt", desired, initial.mtime),
		);
		const rows = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					readonly state: string;
					readonly mtime: string | null;
				}>`
					SELECT state, mtime FROM fs_write_receipts
					WHERE command_id = ${id}
				`;
			}),
		);

		expect(rows).toEqual([{ state: "applied", mtime: receipt.mtime }]);
		expect(await nodeFs.readFile(target, "utf8")).toBe(desired);
	});

	it("rejects command id reuse with another payload or target", async () => {
		await nodeFs.writeFile(nodePath.join(root, "one.txt"), "one");
		await nodeFs.writeFile(nodePath.join(root, "two.txt"), "two");
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "one.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");
		const id = commandId("reused-write-command");
		await runtime.runPromise(
			service.writeFile(id, folderId, "one.txt", "updated", initial.mtime),
		);

		const payloadFailure = await runtime.runPromise(
			Effect.flip(
				service.writeFile(id, folderId, "one.txt", "different", initial.mtime),
			),
		);
		const targetFailure = await runtime.runPromise(
			Effect.flip(
				service.writeFile(id, folderId, "two.txt", "updated", initial.mtime),
			),
		);

		expect(payloadFailure).toEqual(
			new FsCommandReuseError({ commandId: id, reason: "payload-mismatch" }),
		);
		expect(targetFailure).toEqual(
			new FsCommandReuseError({ commandId: id, reason: "target-mismatch" }),
		);
		expect(await nodeFs.readFile(nodePath.join(root, "two.txt"), "utf8")).toBe(
			"two",
		);
	});

	it("serializes writes to one target so a stale concurrent write conflicts", async () => {
		const target = nodePath.join(root, "shared.txt");
		await nodeFs.writeFile(target, "before");
		const oldTime = new Date("2020-01-01T00:00:00.000Z");
		await nodeFs.utimes(target, oldTime, oldTime);
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "shared.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");

		const results = await Promise.all([
			runtime.runPromise(
				Effect.result(
					service.writeFile(
						commandId("concurrent-write-a"),
						folderId,
						"shared.txt",
						"first",
						initial.mtime,
					),
				),
			),
			runtime.runPromise(
				Effect.result(
					service.writeFile(
						commandId("concurrent-write-b"),
						folderId,
						"shared.txt",
						"second",
						initial.mtime,
					),
				),
			),
		]);

		expect(results.filter(Result.isSuccess)).toHaveLength(1);
		const failure = results.find(Result.isFailure);
		expect(failure?._tag).toBe("Failure");
		if (failure !== undefined && Result.isFailure(failure)) {
			expect(failure.failure._tag).toBe("FsConflictError");
		}
		expect(["first", "second"]).toContain(
			await nodeFs.readFile(target, "utf8"),
		);
	});

	it("prunes expired receipts while accepting a new intent", async () => {
		const target = nodePath.join(root, "active.txt");
		await nodeFs.writeFile(target, "before");
		const service = await runtime.runPromise(FsService);
		const initial = await runtime.runPromise(
			service.readFile(folderId, "active.txt"),
		);
		if (initial.kind !== "text") throw new Error("expected text fixture");
		const expiredId = commandId("expired-write-receipt");

		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO fs_write_receipts
						(command_id, folder_id, worktree_id, path, expected_mtime,
						 content_hash, state, mtime, created_at, updated_at)
					VALUES
						(${expiredId}, ${folderId}, NULL, 'old.txt', 'old',
						 ${hash("old")}, 'applied', 'old', 0, 0)
				`;
			}),
		);
		await runtime.runPromise(
			service.writeFile(
				commandId("new-write-receipt"),
				folderId,
				"active.txt",
				"after",
				initial.mtime,
			),
		);

		const rows = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql`
					SELECT command_id FROM fs_write_receipts
					WHERE command_id = ${expiredId}
				`;
			}),
		);
		expect(rows).toEqual([]);
	});
});

describe("deferred directories", () => {
	let root: string;
	let runtime: ReturnType<typeof makeRuntime>;

	const write = async (rel: string, content = ""): Promise<void> => {
		await nodeFs.mkdir(nodePath.dirname(nodePath.join(root, rel)), {
			recursive: true,
		});
		await nodeFs.writeFile(nodePath.join(root, rel), content);
	};

	beforeEach(async () => {
		root = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "zuse-fs-tree-"));
		await write("src/app.ts");
		await write("node_modules/pkg/index.js");
		await write(".venv/lib/site.py");
		await write(".git/HEAD");
		await write(".env");
		runtime = makeRuntime(root, new Set([".venv"]));
	});

	afterEach(async () => {
		await runtime.dispose();
		await nodeFs.rm(root, { recursive: true, force: true });
	});

	it("lists deferred directories without walking them", async () => {
		const listing = await runtime.runPromise(
			Effect.flatMap(FsService, (fs) => fs.listPaths(folderId, null)),
		);

		expect(listing.paths).toEqual([
			".venv/",
			"node_modules/",
			"src/",
			"src/app.ts",
			".env",
		]);
		expect(listing.deferredDirectories).toEqual([".venv", "node_modules"]);
		expect(listing.truncated).toBe(false);
	});

	it("marks deferred directories and their descendants in one-level listings", async () => {
		const [top, inside] = await runtime.runPromise(
			Effect.flatMap(FsService, (fs) =>
				Effect.all([
					fs.tree(folderId, "", null),
					fs.tree(folderId, "node_modules", null),
				]),
			),
		);

		expect(
			top.map((entry) => [entry.path, entry.deferred === true] as const),
		).toEqual([
			[".venv", true],
			["node_modules", true],
			["src", false],
			[".env", false],
		]);
		expect(inside.map((entry) => [entry.path, entry.deferred])).toEqual([
			["node_modules/pkg", true],
		]);
	});

	it("does not report changes inside deferred directories", async () => {
		const changed: string[] = [];
		let ready = false;
		const fiber = runtime.runFork(
			Effect.gen(function* () {
				const fs = yield* FsService;
				yield* Stream.runForEach(fs.watchTree(folderId, null), (event) =>
					Effect.sync(() => {
						if (event._tag === "ready") ready = true;
						if (event._tag === "changed") changed.push(...event.paths);
					}),
				);
			}),
		);
		const waitFor = async (condition: () => boolean, label: string) => {
			const deadline = Date.now() + 3_000;
			while (!condition()) {
				if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		};
		try {
			await waitFor(() => ready, "watcher ready");
			await write("node_modules/pkg/index.js", "changed");
			await write(".venv/lib/site.py", "changed");
			await write("src/app.ts", "changed");
			await waitFor(() => changed.includes("src/app.ts"), "source change");
			// A directory created after the watcher attached is watched too.
			await write("src/feature/new.ts");
			await waitFor(
				() => changed.includes("src/feature/new.ts"),
				"new directory change",
			);
			expect(
				changed.filter(
					(path) =>
						path.startsWith("node_modules/") || path.startsWith(".venv/"),
				),
			).toEqual([]);
		} finally {
			await runtime.runPromise(Fiber.interrupt(fiber));
		}
	});
});
