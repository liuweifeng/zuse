import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { FolderId, PermissionRequest, SessionId } from "@zuse/contracts";
import type { DispatchInput } from "@zuse/domain/engine/dispatch";
import {
	SessionDomain,
	type SessionDomainApi,
} from "@zuse/domain/engine/session-domain";
import { createSessionInputProjection } from "@zuse/domain/projectors/sql-input-projector";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { Migration0061Jobs } from "../../src/persistence/migrations/0061_jobs.ts";
import { PermissionServiceLive } from "../../src/provider/layers/permission-service.ts";
import type { PermissionServiceShape } from "../../src/provider/services/permission-service.ts";
import { PermissionService } from "../../src/provider/services/permission-service.ts";

const directories: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const makeRuntime = (
	filename: string,
	userData: string,
	beforeDispatch?: (
		input: DispatchInput,
		domain: SessionDomainApi,
	) => Effect.Effect<void>,
) => {
	const sql = sqliteLayer({ filename });
	const domain = SessionDomain.layer.pipe(
		Layer.provide(sql),
		Layer.provide(NodeServices.layer),
	);
	const guardedDomain =
		beforeDispatch === undefined
			? domain
			: Layer.effect(
					SessionDomain,
					Effect.map(SessionDomain, (current) => ({
						...current,
						dispatch: (input: DispatchInput) =>
							beforeDispatch(input, current).pipe(
								Effect.andThen(current.dispatch(input)),
							),
					})),
				).pipe(Layer.provide(domain));
	return ManagedRuntime.make(
		PermissionServiceLive.pipe(
			Layer.provideMerge(guardedDomain),
			Layer.provideMerge(sql),
			Layer.provide(Layer.succeed(AppPaths, { userData })),
		),
	);
};

const createSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* Migration0061Jobs;
	yield* createSessionInputProjection(sql);
	yield* sql`CREATE TABLE queued_messages (id TEXT, session_id TEXT, input_json TEXT, queue_order INTEGER, created_at TEXT, updated_at TEXT, ready INTEGER)`;
	yield* sql`
		CREATE TABLE chats (
			id TEXT PRIMARY KEY, project_id TEXT, worktree_id TEXT, title TEXT,
			title_provenance TEXT NOT NULL DEFAULT 'manual',
			active_session_id TEXT, origin_session_id TEXT, archived_at TEXT,
			archived_worktree_json TEXT, last_message_at TEXT, last_user_message_at TEXT, last_read_at TEXT,
			created_at TEXT, updated_at TEXT
		)
	`;
	yield* sql`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
			title_provenance TEXT NOT NULL DEFAULT 'manual',
			provider_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
			archived_at TEXT, active_provider_thread_id TEXT, provider_reservation_id TEXT,
			runtime_mode TEXT NOT NULL, agents_json TEXT, worktree_id TEXT,
			chat_id TEXT NOT NULL, forked_from_session_id TEXT,
			forked_from_message_id TEXT, permission_mode TEXT NOT NULL,
			tool_search INTEGER NOT NULL, queue_paused INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE session_provider_threads (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
			native_thread_id TEXT NOT NULL, native_head_id TEXT, status TEXT NOT NULL,
			first_turn_ordinal INTEGER, last_turn_ordinal INTEGER,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE IF NOT EXISTS session_attempts (
			session_id TEXT NOT NULL,
			id TEXT NOT NULL,
			turn_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL CHECK (ordinal > 0),
			reason TEXT NOT NULL CHECK (reason IN ('initial', 'retry', 'provider_recovery')),
			status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'failed', 'superseded')),
			started_at TEXT NOT NULL,
			completed_at TEXT,
			started_sequence INTEGER NOT NULL,
			updated_sequence INTEGER NOT NULL,
			provider_turn_json TEXT,
			PRIMARY KEY (session_id, id),
			UNIQUE (session_id, turn_id, ordinal)
		)
	`;
	yield* sql`
		CREATE TABLE session_turns (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
			status TEXT NOT NULL, phase TEXT, provider_thread_id TEXT,
			active_attempt_id TEXT NOT NULL, attempt_ordinal INTEGER NOT NULL,
			attempt_reason TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT,
			UNIQUE (session_id, ordinal)
		)
	`;
	yield* sql`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
			kind TEXT NOT NULL, content_json TEXT NOT NULL, parent_item_id TEXT,
			turn_id TEXT, created_at TEXT NOT NULL, sequence INTEGER NOT NULL,
			checkpoint_revision INTEGER, checkpoint_final INTEGER
		)
	`;
	yield* sql`
		CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)
	`;
	yield* sql`
		CREATE TABLE events (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
			correlation_id TEXT, causation_event_id TEXT, stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL, type TEXT NOT NULL,
			occurred_at TEXT NOT NULL, actor TEXT, payload_json TEXT NOT NULL,
			UNIQUE (stream_kind, stream_id, stream_version)
		)
	`;
	yield* sql`
		CREATE TABLE projector_cursors (
			projector_name TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE command_receipts (
			command_id TEXT PRIMARY KEY, stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
			event_ids_json TEXT NOT NULL, result_json TEXT,
			fingerprint TEXT, command_kind TEXT, schema_version INTEGER,
			storage_incarnation_id TEXT, created_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE permission_decisions (
			request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
			kind_tag TEXT NOT NULL, kind_key TEXT NOT NULL, kind_json TEXT NOT NULL,
			decision TEXT NOT NULL, decided_at TEXT NOT NULL, project_id TEXT,
			scope TEXT NOT NULL DEFAULT 'session'
		)
	`;
	yield* sql`
		INSERT INTO chats (id, project_id, title, created_at, updated_at)
		VALUES ('chat-1', 'project-1', 'Chat', '1970-01-01T00:00:00.001Z',
			'1970-01-01T00:00:00.001Z')
	`;
});

const createSession = Effect.gen(function* () {
	const domain = yield* SessionDomain;
	yield* domain.dispatch({
		commandId: "create-session",
		streamId: "session-1",
		command: {
			_tag: "CreateSession",
			sessionId: "session-1",
			chatId: "chat-1",
			projectId: "project-1",
			title: "Session",
			providerId: "claude",
			model: "model-1",
			status: "running",
			runtimeMode: "approval-required",
			agentsJson: null,
			worktreeId: null,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: "default",
			toolSearch: false,
			queuePaused: false,
			createdAt: 1,
		},
	});
	yield* domain.dispatch({
		commandId: "start-turn",
		streamId: "session-1",
		command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 2 },
	});
});

describe("PermissionService restart recovery", () => {
	const permissionRequests = (
		stream: ReturnType<PermissionServiceShape["requests"]>,
	) =>
		stream.pipe(
			Stream.flatMap((change) =>
				change._tag === "snapshot"
					? Stream.fromIterable(change.requests)
					: change._tag === "change"
						? Stream.succeed(change.request)
						: Stream.empty,
			),
		);

	test("does not expose a callback before its request commits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-permission-admission-"));
		directories.push(directory);
		const filename = join(directory, "test.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(createSchema);
		await schemaRuntime.dispose();
		const entered = await Effect.runPromise(Deferred.make<void>());
		const release = await Effect.runPromise(Deferred.make<void>());
		let current = true;
		const runtime = makeRuntime(filename, directory, (input) =>
			input.command._tag === "RequestPermission"
				? Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					)
				: Effect.void,
		);
		try {
			await runtime.runPromise(createSession);
			const callback = runtime.runFork(
				Effect.flatMap(PermissionService, (service) =>
					service.request(
						SessionId.make("session-1"),
						{ _tag: "Bash", command: "git status" },
						{
							projectId: FolderId.make("project-1"),
							isCurrent: Effect.sync(() => current),
						},
					),
				),
			);
			await Effect.runPromise(Deferred.await(entered));
			current = false;
			expect(
				await runtime.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.listPending(SessionId.make("session-1")),
					),
				),
			).toEqual([]);
			await Effect.runPromise(Deferred.succeed(release, undefined));
			expect(
				await Effect.runPromise(
					Fiber.join(callback).pipe(Effect.timeout("3 seconds")),
				),
			).toEqual({ _tag: "Deny" });
			const pending = await runtime.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.listPending(SessionId.make("session-1")),
				),
			);
			expect(pending).toEqual([
				expect.objectContaining({ recoveryState: "expired" }),
			]);
			const events = await runtime.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`SELECT type FROM events WHERE type IN ('PermissionRequested', 'PermissionExpired') ORDER BY sequence`,
				),
			);
			expect(events.map((event) => event.type)).toEqual([
				"PermissionRequested",
				"PermissionExpired",
			]);
		} finally {
			await Effect.runPromise(Deferred.succeed(release, undefined));
			await runtime.dispose();
		}
	});

	test.each([
		"request",
		"decision",
	] as const)("rejects Stop between approval %s preflight and commit", async (boundary) => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-permission-race-"));
		directories.push(directory);
		const filename = join(directory, "test.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(createSchema);
		await schemaRuntime.dispose();
		let armed = false;
		const runtime = makeRuntime(filename, directory, (input, domain) =>
			Effect.gen(function* () {
				if (
					!armed ||
					input.command._tag !==
						(boundary === "request" ? "RequestPermission" : "ResolvePermission")
				)
					return;
				armed = false;
				yield* domain
					.dispatch({
						commandId: "race-stop",
						streamId: "session-1",
						command: { _tag: "RequestTurnInterrupt", requestedAt: 4 },
					})
					.pipe(Effect.orDie);
			}),
		);
		try {
			await runtime.runPromise(createSession);
			const attempt = await runtime.runPromise(
				Effect.gen(function* () {
					const domain = yield* SessionDomain;
					const attempt = yield* domain.activeAttempt("session-1");
					if (attempt === null) throw new Error("Missing attempt");
					yield* domain.dispatch({
						commandId: "reserve",
						streamId: "session-1",
						command: {
							_tag: "ReserveProviderSession",
							providerId: "claude",
							expectedModel: "model-1",
							expectedWorktreeId: null,
							providerSessionId: "provider-1",
							ownerAttempt: attempt,
							reservedAt: 3,
						},
					});
					return attempt;
				}),
			);
			armed = boundary === "request";
			const callback = runtime.runFork(
				Effect.flatMap(PermissionService, (service) =>
					service.request(
						SessionId.make("session-1"),
						{ _tag: "Bash", command: "git status" },
						{
							projectId: FolderId.make("project-1"),
							owner: { providerSessionId: "provider-1", attempt },
						},
					),
				),
			);
			if (boundary === "decision") {
				const [published] = await runtime.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						permissionRequests(service.requests()).pipe(
							Stream.take(1),
							Stream.runCollect,
						),
					),
				);
				if (published === undefined) throw new Error("Missing request");
				armed = true;
				await expect(
					runtime.runPromise(
						Effect.flatMap(PermissionService, (service) =>
							service.decide(published.id, { _tag: "AllowOnce" }),
						),
					),
				).rejects.toMatchObject({ _tag: "PermissionRequestExpiredError" });
			}
			expect(
				await Effect.runPromise(
					Fiber.join(callback).pipe(Effect.timeout("1 second")),
				),
			).toEqual({ _tag: "Deny" });
			const rows = await runtime.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`SELECT type FROM events WHERE type IN ('PermissionRequested', 'PermissionExpired', 'PermissionResolved') ORDER BY sequence`,
				),
			);
			expect(rows.map((row) => row.type)).toEqual(
				boundary === "request"
					? []
					: ["PermissionRequested", "PermissionExpired"],
			);
			expect(
				await runtime.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.listDecisions({}),
					),
				),
			).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	test.each([
		"stop",
		"replacement",
		"physical-release",
		"background-expiry",
		"deleted",
		"expired-then-deleted",
		"archived",
		"retry",
	] as const)("expires exact approval ownership after %s", async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-permission-owner-"));
		directories.push(directory);
		const filename = join(directory, "test.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(createSchema);
		await schemaRuntime.dispose();
		const runtime = makeRuntime(filename, directory);
		let current = true;
		try {
			await runtime.runPromise(createSession);
			const attempt = await runtime.runPromise(
				Effect.gen(function* () {
					const domain = yield* SessionDomain;
					const attempt = yield* domain.activeAttempt("session-1");
					if (attempt === null) throw new Error("Missing attempt");
					yield* domain.dispatch({
						commandId: "reserve",
						streamId: "session-1",
						command: {
							_tag: "ReserveProviderSession",
							providerId: "claude",
							expectedModel: "model-1",
							expectedWorktreeId: null,
							providerSessionId: "provider-1",
							ownerAttempt: attempt,
							reservedAt: 3,
						},
					});
					return attempt;
				}),
			);
			const requestOptions = {
				projectId: FolderId.make("project-1"),
				owner: { providerSessionId: "provider-1", attempt },
				isCurrent: Effect.sync(() => current),
			};
			const callback = runtime.runFork(
				Effect.flatMap(PermissionService, (service) =>
					service.request(
						SessionId.make("session-1"),
						{ _tag: "Bash", command: "git status" },
						requestOptions,
					),
				),
			);
			const [published] = await runtime.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					permissionRequests(service.requests()).pipe(
						Stream.take(1),
						Stream.runCollect,
					),
				),
			);
			if (published === undefined) throw new Error("Missing request");
			if (
				mode === "physical-release" ||
				mode === "background-expiry" ||
				mode === "expired-then-deleted"
			)
				current = false;
			else
				await runtime.runPromise(
					Effect.flatMap(SessionDomain, (domain) =>
						domain.dispatch({
							commandId: "revoke",
							streamId: "session-1",
							command:
								mode === "deleted"
									? { _tag: "DeleteSession", deletedAt: 4 }
									: mode === "archived"
										? { _tag: "ArchiveSession", archivedAt: 4 }
										: mode === "stop"
											? { _tag: "RequestTurnInterrupt", requestedAt: 4 }
											: mode === "retry"
												? {
														_tag: "RetryTurn",
														turnId: attempt.turnId,
														reason: "retry",
														providerInputJson: "{}",
														requestedAt: 4,
													}
												: {
														_tag: "ReserveProviderSession",
														providerId: "claude",
														expectedModel: "model-1",
														expectedWorktreeId: null,
														providerSessionId: "provider-2",
														ownerAttempt: attempt,
														reservedAt: 4,
													},
						}),
					),
				);
			if (mode === "background-expiry")
				expect(
					await Effect.runPromise(
						Fiber.join(callback).pipe(Effect.timeout("3 seconds")),
					),
				).toEqual({ _tag: "Deny" });
			const pending = await runtime.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.listPending(SessionId.make("session-1")),
				),
			);
			if (mode === "deleted") {
				expect(pending).toEqual([]);
				expect(
					await Effect.runPromise(
						Fiber.join(callback).pipe(Effect.timeout("1 second")),
					),
				).toEqual({ _tag: "Deny" });
				return;
			}
			expect(pending).toEqual([
				expect.objectContaining({ id: published.id, recoveryState: "expired" }),
			]);
			expect(
				await Effect.runPromise(
					Fiber.join(callback).pipe(Effect.timeout("1 second")),
				),
			).toEqual({ _tag: "Deny" });
			await expect(
				runtime.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.decide(published.id, {
							_tag: "AlwaysAllow",
							scope: "folder",
						}),
					),
				),
			).rejects.toMatchObject({ _tag: "PermissionRequestExpiredError" });
			const snapshot = await runtime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.timelineSnapshot(SessionId.make("session-1")),
				),
			);
			expect(snapshot.projection.interactions).toEqual([
				expect.objectContaining({
					_tag: "Permission",
					request: expect.objectContaining({ recoveryState: "expired" }),
				}),
			]);
			const late = await runtime.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.request(
						SessionId.make("session-1"),
						{ _tag: "Bash", command: "git status" },
						requestOptions,
					),
				),
			);
			expect(late).toEqual({ _tag: "Deny" });
			const rows = await runtime.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`SELECT type FROM events WHERE type IN ('PermissionRequested', 'PermissionExpired', 'PermissionResolved') ORDER BY sequence`,
				),
			);
			expect(rows.map((row) => row.type)).toEqual([
				"PermissionRequested",
				"PermissionExpired",
			]);
			if (mode === "expired-then-deleted") {
				await runtime.runPromise(
					Effect.flatMap(SessionDomain, (domain) =>
						domain.dispatch({
							commandId: "delete-expired",
							streamId: "session-1",
							command: { _tag: "DeleteSession", deletedAt: 5 },
						}),
					),
				);
				expect(
					await runtime.runPromise(
						Effect.flatMap(PermissionService, (service) =>
							service.listPending(SessionId.make("session-1")),
						),
					),
				).toEqual([]);
				return;
			}
			await runtime.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.decide(published.id, { _tag: "Deny" }),
				),
			);
			expect(
				await runtime.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.listPending(SessionId.make("session-1")),
					),
				),
			).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	test.each([
		false,
		true,
	])("recovers legacy approval records without settling a newer turn (newer=%s)", async (newer) => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-permission-legacy-"));
		directories.push(directory);
		const filename = join(directory, "test.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(createSchema);
		await schemaRuntime.dispose();
		const first = makeRuntime(filename, directory);
		await first.runPromise(createSession);
		// Reproduce the old runtime's event: turnId incorrectly held requestId.
		await first.runPromise(
			Effect.gen(function* () {
				const domain = yield* SessionDomain;
				yield* domain.dispatch({
					commandId: "legacy-request",
					streamId: "session-1",
					command: {
						_tag: "RequestPermission",
						requestId: "legacy",
						turnId: "legacy",
						requestedAt: 3,
						payloadJson: JSON.stringify(
							PermissionRequest.make({
								id: "legacy",
								sessionId: SessionId.make("session-1"),
								kind: { _tag: "Bash", command: "git status" },
								requestedAt: new Date(3),
								forcePrompt: false,
							}),
						),
					},
				});
				if (newer) {
					yield* domain.dispatch({
						commandId: "settle-old",
						streamId: "session-1",
						command: {
							_tag: "SettleTurn",
							turnId: "turn-1",
							outcome: "interrupted",
							settledAt: 4,
						},
					});
					yield* domain.dispatch({
						commandId: "start-new",
						streamId: "session-1",
						command: { _tag: "StartTurn", turnId: "turn-2", startedAt: 5 },
					});
				}
			}),
		);
		await first.dispose();
		const restarted = makeRuntime(filename, directory);
		try {
			const rows = await restarted.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`SELECT t.id AS current_turn_id FROM sessions s LEFT JOIN session_turns t ON t.session_id = s.id AND t.status IN ('starting', 'running') WHERE s.id = 'session-1'`,
				),
			);
			expect(rows).toEqual([{ current_turn_id: newer ? "turn-2" : null }]);
			expect(
				await restarted.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.listPending(SessionId.make("session-1")),
					),
				),
			).toEqual([
				expect.objectContaining({ id: "legacy", recoveryState: "expired" }),
			]);
		} finally {
			await restarted.dispose();
		}
	});

	test("replays a live approval when the first client arrives thirty minutes late", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-permission-offline-"));
		directories.push(directory);
		const filename = join(directory, "test.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(createSchema);
		await schemaRuntime.dispose();
		const runtime = makeRuntime(filename, directory);
		await runtime.runPromise(createSession);
		const callback = runtime.runFork(
			Effect.flatMap(PermissionService, (service) =>
				service.request(
					SessionId.make("session-1"),
					{ _tag: "Bash", command: "git status" },
					{ projectId: FolderId.make("project-1") },
				),
			),
		);
		try {
			// No client subscription while the provider creates and persists its ask.
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					while (
						(yield* sql`SELECT sequence FROM events WHERE type = 'PermissionRequested'`)
							.length === 0
					)
						yield* Effect.yieldNow;
				}).pipe(Effect.timeout(1_000)),
			);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(Date.now() + 30 * 60 * 1_000);
			const reconnect = () =>
				runtime.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.requests().pipe(Stream.take(1), Stream.runCollect),
					),
				);
			const [snapshot] = await reconnect();
			expect(snapshot?._tag).toBe("snapshot");
			if (snapshot?._tag !== "snapshot") throw new Error("Missing snapshot");
			const pending = snapshot.requests[0];
			expect(pending?.recoveryState).toBeUndefined();
			expect(pending?.requestedAt.getTime()).toBeLessThanOrEqual(
				Date.now() - 30 * 60 * 1_000,
			);
			expect(await reconnect()).toEqual([snapshot]);
			await runtime.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.decide(pending?.id ?? "missing", { _tag: "AllowOnce" }),
				),
			);
			expect(
				await Effect.runPromise(
					Fiber.join(callback).pipe(Effect.timeout(1_000)),
				),
			).toEqual({ _tag: "AllowOnce" });
			expect(await reconnect()).toEqual([{ _tag: "snapshot", requests: [] }]);
		} finally {
			await Effect.runPromise(Fiber.interrupt(callback));
			await runtime.dispose();
		}
	});

	test("keeps a restarted approval visible but never reuses it for a new tool call", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-permission-restart-"));
		directories.push(directory);
		const filename = join(directory, "test.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(createSchema);
		await schemaRuntime.dispose();
		const first = makeRuntime(filename, directory);
		await first.runPromise(createSession);
		const requestFiber = first.runFork(
			Effect.flatMap(PermissionService, (service) =>
				service.request(
					SessionId.make("session-1"),
					{ _tag: "Bash", command: "git status" },
					{ projectId: FolderId.make("project-1") },
				),
			),
		);
		const [published] = await first.runPromise(
			Effect.flatMap(PermissionService, (service) =>
				permissionRequests(service.requests()).pipe(
					Stream.take(1),
					Stream.runCollect,
				),
			),
		);
		expect(published).toBeInstanceOf(PermissionRequest);
		await first.dispose();
		await Effect.runPromise(Fiber.interrupt(requestFiber));

		const restarted = makeRuntime(filename, directory);
		try {
			const pending = await restarted.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.listPending(SessionId.make("session-1")),
				),
			);
			expect(pending).toEqual([
				expect.objectContaining({
					id: published?.id,
					recoveryState: "expired",
				}),
			]);
			expect(
				await restarted.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.requests().pipe(Stream.take(1), Stream.runCollect),
					),
				),
			).toEqual([{ _tag: "snapshot", requests: pending }]);
			await expect(
				restarted.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.decide(published?.id ?? "missing", {
							_tag: "AlwaysAllow",
							scope: "folder",
						}),
					),
				),
			).rejects.toMatchObject({ _tag: "PermissionRequestExpiredError" });
			const session = await restarted.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`SELECT s.status, t.id AS current_turn_id FROM sessions s LEFT JOIN session_turns t ON t.session_id = s.id AND t.status IN ('starting', 'running') WHERE s.id = 'session-1'`,
				),
			);
			expect(session).toEqual([{ status: "idle", current_turn_id: null }]);
			const republished = restarted.runFork(
				Effect.flatMap(PermissionService, (service) =>
					permissionRequests(service.requests()).pipe(
						Stream.filter((request) => request.id !== published?.id),
						Stream.take(1),
						Stream.runCollect,
					),
				),
			);
			await restarted.runPromise(Effect.yieldNow);
			const reattached = restarted.runFork(
				Effect.flatMap(PermissionService, (service) =>
					service.request(
						SessionId.make("session-1"),
						{ _tag: "Bash", command: "git status" },
						{ projectId: FolderId.make("project-1") },
					),
				),
			);
			const [liveRequest] = await Effect.runPromise(
				Fiber.join(republished).pipe(Effect.timeout(1_000)),
			);
			expect(liveRequest?.id).not.toBe(published?.id);
			expect(
				await restarted.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.listPending(SessionId.make("session-1")),
					),
				),
			).toEqual([pending[0], liveRequest]);
			await restarted.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.decide(liveRequest?.id ?? "missing", { _tag: "AllowOnce" }),
				),
			);
			await expect(
				Effect.runPromise(Fiber.join(reattached).pipe(Effect.timeout(1_000))),
			).resolves.toEqual({ _tag: "AllowOnce" });
			expect(
				await restarted.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.listPending(SessionId.make("session-1")),
					),
				),
			).toEqual(pending);
			const decisions = await restarted.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.listDecisions({ projectId: FolderId.make("project-1") }),
				),
			);
			expect(decisions.map((decision) => decision.requestId)).toEqual([
				liveRequest?.id,
			]);
			await restarted.runPromise(
				Effect.flatMap(PermissionService, (service) =>
					service.decide(published?.id ?? "missing", { _tag: "Deny" }),
				),
			);
		} finally {
			await restarted.dispose();
		}
		const secondRestart = makeRuntime(filename, directory);
		try {
			expect(
				await secondRestart.runPromise(
					Effect.flatMap(PermissionService, (service) =>
						service.listPending(SessionId.make("session-1")),
					),
				),
			).toEqual([]);
			const [settlements] = await secondRestart.runPromise(
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql`SELECT count(*) AS count FROM events WHERE type = 'TurnSettled'`,
				),
			);
			expect(settlements?.count).toBe(1);
		} finally {
			await secondRestart.dispose();
		}
	});
});
