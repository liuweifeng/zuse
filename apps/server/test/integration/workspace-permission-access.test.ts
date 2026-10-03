import {
	ChatId,
	FolderId,
	PermissionRequest,
	type PermissionRequestChange,
	SessionId,
} from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it, vi } from "vitest";
import { filterPermissionCatalog } from "../../src/collaboration/services/catalog-visibility.ts";
import { authorizeWorkspaceRpc } from "../../src/lan-auth/layers/workspace-rpc-authorization.ts";
import { PermissionService } from "../../src/provider/services/permission-service.ts";

it("delivers only the chat's live approvals and enforces edit authority on decisions", async () => {
	const request = (id: string, sessionId: string) =>
		PermissionRequest.make({
			id,
			sessionId: SessionId.make(sessionId),
			kind: { _tag: "Bash", command: "pwd" },
			requestedAt: new Date(),
			forcePrompt: false,
		});
	const own = request("own", "session"),
		other = request("other", "private-session");
	const frames: PermissionRequestChange[] = [
		{ _tag: "snapshot", requests: [own, other] },
		{ _tag: "change", request: other },
		{ _tag: "change", request: own },
		{ _tag: "remove", requestId: other.id },
		{ _tag: "remove", requestId: own.id },
	];
	const decide = vi.fn(() => Effect.void);
	const service = PermissionService.of({
		request: () => Effect.succeed({ _tag: "Deny" }),
		decide,
		listPending: (id) => Effect.succeed(id === own.sessionId ? [own] : [other]),
		requests: () => Stream.fromIterable(frames),
		listDecisions: () => Effect.succeed([]),
		revokeDecision: () => Effect.void,
	});
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			sqliteLayer({ filename: ":memory:", disableWAL: true }),
			Layer.succeed(PermissionService, service),
		),
	);
	let permission: "edit" | "view" = "edit";
	const identity = {
		kind: "workspace" as const,
		subject: "actor",
		membershipId: "member",
		workspaceId: "workspace",
		chatId: ChatId.make("chat"),
		projectId: FolderId.make("project"),
		expiresAt: Date.now() + 60_000,
		authorize: Effect.suspend(() => Effect.succeed(permission)),
	};
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE chats (id TEXT, project_id TEXT, worktree_id TEXT)`;
				yield* sql`CREATE TABLE sessions (id TEXT, chat_id TEXT)`;
				yield* sql`INSERT INTO chats VALUES ('chat','project',NULL)`;
				yield* sql`INSERT INTO sessions VALUES ('session','chat'),('private-session','private')`;
			}),
		);
		const feed = service
			.requests()
			.pipe(filterPermissionCatalog, Stream.runCollect);
		expect(
			await runtime.runPromise(
				authorizeWorkspaceRpc(feed, identity, "permission.requests", {}),
			),
		).toEqual([
			{ _tag: "snapshot", requests: [own] },
			{ _tag: "change", request: own },
			{ _tag: "remove", requestId: own.id },
		]);
		const runDecision = (
			requestId: string,
			decision:
				| { _tag: "AllowOnce" }
				| { _tag: "AlwaysAllow"; scope: "global" },
		) =>
			runtime.runPromise(
				authorizeWorkspaceRpc(
					Effect.suspend(() => service.decide(requestId, decision)),
					identity,
					"permission.decide",
					{ requestId, decision },
				),
			);
		await runDecision(own.id, { _tag: "AllowOnce" });
		expect(decide).toHaveBeenCalledTimes(1);
		await expect(
			runDecision(other.id, { _tag: "AllowOnce" }),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		await expect(
			runDecision(own.id, { _tag: "AlwaysAllow", scope: "global" }),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		permission = "view";
		await expect(
			runDecision(own.id, { _tag: "AllowOnce" }),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		expect(decide).toHaveBeenCalledTimes(1);
		await expect(
			runtime.runPromise(
				authorizeWorkspaceRpc(Effect.void, identity, "permission.listPending", {
					sessionId: other.sessionId,
				}),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
	} finally {
		await runtime.dispose();
	}
});

it("requires edit access to both the fork and its parent before merging context", async () => {
	const runtime = ManagedRuntime.make(
		sqliteLayer({ filename: ":memory:", disableWAL: true }),
	);
	let permission: "edit" | "view" = "edit";
	const identity = {
		kind: "workspace" as const,
		subject: "actor",
		membershipId: "member",
		workspaceId: "workspace",
		chatId: ChatId.make("chat"),
		projectId: FolderId.make("project"),
		expiresAt: Date.now() + 60_000,
		authorize: Effect.suspend(() => Effect.succeed(permission)),
	};
	const execute = vi.fn();
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE chats(id TEXT,project_id TEXT,worktree_id TEXT)`;
				yield* sql`CREATE TABLE sessions(id TEXT,chat_id TEXT,forked_from_session_id TEXT)`;
				yield* sql`INSERT INTO chats VALUES ('chat','project',NULL)`;
				yield* sql`INSERT INTO sessions VALUES ('parent','chat',NULL),('private-parent','private',NULL),('child','chat','parent'),('other-child','chat','private-parent')`;
				yield* sql`CREATE TABLE session_fork_constructions(session_id TEXT,payload_json TEXT)`;
				yield* sql`INSERT INTO session_fork_constructions VALUES ('local-fork','{"chatId":"chat"}'),('private-fork','{"chatId":"private"}')`;
			}),
		);
		const merge = (sessionId: string) =>
			runtime.runPromise(
				authorizeWorkspaceRpc(
					Effect.sync(execute),
					identity,
					"session.mergeBack",
					{ sessionId },
				),
			);
		await merge("child");
		await expect(merge("other-child")).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
		});
		permission = "view";
		await expect(merge("child")).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
		});
		for (const tag of ["session.retryFork", "session.cancelFork"]) {
			await expect(
				runtime.runPromise(
					authorizeWorkspaceRpc(Effect.sync(execute), identity, tag, {
						sessionId: "child",
						forkSessionId: "local-fork",
					}),
				),
			).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
			permission = "edit";
			await expect(
				runtime.runPromise(
					authorizeWorkspaceRpc(Effect.sync(execute), identity, tag, {
						sessionId: "child",
						forkSessionId: "private-fork",
					}),
				),
			).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
			await runtime.runPromise(
				authorizeWorkspaceRpc(Effect.sync(execute), identity, tag, {
					sessionId: "child",
					forkSessionId: "local-fork",
				}),
			);
			permission = "view";
		}
		expect(execute).toHaveBeenCalledTimes(3);
	} finally {
		await runtime.dispose();
	}
});

it.each([
	"session.attempts.list",
	"session.wait",
])("allows scoped read-only %s and denies another chat", async (tag) => {
	const runtime = ManagedRuntime.make(
		sqliteLayer({ filename: ":memory:", disableWAL: true }),
	);
	const identity = {
		kind: "workspace" as const,
		subject: "reader",
		membershipId: "member",
		workspaceId: "workspace",
		chatId: ChatId.make("chat"),
		projectId: FolderId.make("project"),
		expiresAt: Date.now() + 60_000,
		authorize: Effect.succeed("view" as const),
	};
	const execute = vi.fn();
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE chats(id TEXT,project_id TEXT,worktree_id TEXT)`;
				yield* sql`CREATE TABLE sessions(id TEXT,chat_id TEXT)`;
				yield* sql`INSERT INTO chats VALUES('chat','project',NULL)`;
				yield* sql`INSERT INTO sessions VALUES('own','chat'),('private','another-chat')`;
			}),
		);
		const read = (sessionId: string) =>
			runtime.runPromise(
				authorizeWorkspaceRpc(Effect.sync(execute), identity, tag, {
					sessionId,
					...(tag === "session.attempts.list"
						? { before: { turnOrdinal: 3, attemptOrdinal: 2 } }
						: { target: "done" }),
				}),
			);
		await read("own");
		await expect(read("private")).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
		});
		await expect(read("missing")).rejects.toMatchObject({
			_tag: "RpcAccessDeniedError",
		});
		await expect(
			runtime.runPromise(
				authorizeWorkspaceRpc(
					Effect.sync(execute),
					identity,
					"session.sendAndWait",
					{ sessionId: "own" },
				),
			),
		).rejects.toMatchObject({ _tag: "RpcAccessDeniedError" });
		expect(execute).toHaveBeenCalledTimes(1);
	} finally {
		await runtime.dispose();
	}
});
