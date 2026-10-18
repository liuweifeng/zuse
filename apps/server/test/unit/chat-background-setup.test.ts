import {
	Chat,
	ChatCreateRpc,
	ChatId,
	ComposerInput,
	FolderId,
	QueuedMessage,
	Session,
	SessionId,
	Worktree,
	type WorktreeId,
} from "@zuse/contracts";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { GitService } from "@zuse/git/git-service";
import { WorktreeService } from "@zuse/git/worktree-service";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Deferred, Effect, Layer, Stream } from "effect";
import { RpcGroup, RpcTest } from "effect/unstable/rpc";
import { SqlClient } from "effect/unstable/sql";
import { expect, it, vi } from "vitest";
import { AnalyticsService } from "../../src/analytics/services/analytics-service.ts";
import {
	ChatService,
	type CreateChatInput,
	QueueService,
	QueueTransactionService,
	SessionService,
} from "../../src/conversation/services/conversation-services.ts";
import { Migration0044ChatCreationOperations } from "../../src/persistence/migrations/0044_chat_creation_operations.ts";
import { Migration0049ChatCreationStartupReady } from "../../src/persistence/migrations/0049_chat_creation_startup_ready.ts";
import { Migration0050DurableChatCreation } from "../../src/persistence/migrations/0050_durable_chat_creation.ts";
import { ChatCreate } from "../../src/provider/handlers.ts";

const projectId = FolderId.make("background-setup-project");

it.each([
	["running", "direct"],
	["failed", "direct"],
	["running", "attachment"],
	["failed", "attachment"],
	["running", "legacy"],
	["failed", "legacy"],
] as const)("starts %s setup's %s chat without waiting", async (setupStatus, mode) => {
	const setupStream = vi.fn(() => Stream.never);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* Migration0044ChatCreationOperations;
				yield* Migration0049ChatCreationStartupReady;
				yield* Migration0050DurableChatCreation;
				yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY, queue_paused INTEGER NOT NULL)`;
				const released = yield* Deferred.make<void>();
				const now = new Date(0);
				const sessionId = SessionId.make(`background-${setupStatus}-${mode}`);
				const chatId = ChatId.make(`chat-${setupStatus}-${mode}`);
				let currentWorktree: Worktree | null = null;
				let status: "idle" | "running" = "idle";
				const session = () =>
					Session.make({
						id: sessionId,
						projectId,
						title: "New chat",
						providerId: "codex",
						model: "model",
						status,
						archivedAt: null,
						providerThread: null,
						runtimeMode: "approval-required",
						worktreeId: currentWorktree?.id ?? null,
						chatId,
						forkedFromSessionId: null,
						forkedFromMessageId: null,
						permissionMode: "default",
						toolSearch: false,
						createdAt: now,
						updatedAt: now,
					});
				const chat = () =>
					Chat.make({
						id: chatId,
						projectId,
						worktreeId: currentWorktree?.id ?? null,
						title: "New chat",
						activeSessionId: sessionId,
						originSessionId: null,
						archivedAt: null,
						createdAt: now,
						updatedAt: now,
						lastMessageAt: null,
						lastReadAt: now,
					});
				const release =
					sql`UPDATE sessions SET queue_paused = 0 WHERE id = ${sessionId}`.pipe(
						Effect.andThen(
							Effect.sync(() => {
								status = "running";
							}),
						),
						Effect.andThen(Deferred.succeed(released, undefined)),
						Effect.asVoid,
					);
				const services = Layer.mergeAll(
					Layer.succeed(ChatService, {
						createChat: (input: CreateChatInput) =>
							sql`INSERT INTO sessions VALUES (${sessionId}, 1)`.pipe(
								Effect.tap(() => (input.queuePaused ? Effect.void : release)),
								Effect.map(() => ({ chat: chat(), initialSession: session() })),
							),
						setChatWorktree: () => Effect.void,
					} as unknown as ChatService["Service"]),
					Layer.succeed(SessionService, {
						releaseInitialTurn: () => release,
						getSession: () => Effect.succeed(session()),
					} as unknown as SessionService["Service"]),
					Layer.succeed(QueueService, {
						resumeQueuedMessages: () => release,
					} as unknown as QueueService["Service"]),
					Layer.succeed(QueueTransactionService, {
						addQueuedMessageTransactionally: (
							_commandId,
							targetSessionId,
							input,
							queueId,
							ready,
							onCommitted,
						) =>
							onCommitted(
								QueuedMessage.make({
									id: queueId,
									sessionId: targetSessionId,
									input,
									ready,
									position: 0,
									createdAt: now,
									updatedAt: now,
								}),
							),
					}),
					Layer.succeed(SessionDomain, {} as SessionDomain["Service"]),
					Layer.succeed(GitService, {
						isRepository: () => Effect.succeed(true),
					} as unknown as GitService["Service"]),
					Layer.succeed(WorktreeService, {
						create: (
							_projectId: FolderId,
							_source: unknown,
							requestedId: WorktreeId,
						) =>
							Effect.sync(() => {
								currentWorktree = Worktree.make({
									id: requestedId,
									projectId,
									path: "/tmp/background-worktree",
									name: "test",
									branch: "test",
									baseBranch: "main",
									createdAt: now,
									setupStatus,
									setupOutput:
										setupStatus === "failed"
											? "dependency install failed"
											: "installing dependencies",
									setupStartedAt: now,
									setupFinishedAt: null,
									pokemon: null,
								});
								return currentWorktree;
							}),
						get: () => Effect.succeed(currentWorktree),
						setupStream,
					} as unknown as WorktreeService["Service"]),
					Layer.succeed(AnalyticsService, {
						capture: () => Effect.void,
						getContext: () => Effect.die("unused analytics context"),
						contextChanges: () => Stream.never,
						flush: Effect.void,
					}),
				);
				yield* Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(
						RpcGroup.make(ChatCreateRpc),
					);
					yield* client["chat.create"]({
						operationId:
							mode === "legacy" ? undefined : `create-${setupStatus}-${mode}`,
						initialPrompt: mode === "legacy" ? "Start chatting now" : undefined,
						startupQueueId: mode === "attachment" ? "startup-image" : undefined,
						chatId,
						initialSessionId: sessionId,
						projectId,
						providerId: "codex",
						model: "model",
						workspacePolicy: { _tag: "fresh" },
						startupInput: ComposerInput.make({
							text: "Start chatting now",
							attachments:
								mode === "attachment"
									? [
											{
												id: "uploaded-image",
												mimeType: "image/png",
												originalName: "image.png",
											},
										]
									: [],
							fileRefs: [],
							skillRefs: [],
							annotations: [],
						}),
						startupReady: true,
					}).pipe(Effect.timeout("300 millis"));
					yield* Deferred.await(released).pipe(
						Effect.timeout("300 millis"),
						Effect.catch(() =>
							Effect.gen(function* () {
								const rows =
									yield* sql`SELECT phase, error FROM chat_creation_operations`;
								return yield* Effect.die(new Error(JSON.stringify(rows)));
							}),
						),
					);
					expect(setupStream).not.toHaveBeenCalled();
					const operations = yield* sql<{
						phase: string;
						failure_stage: string | null;
					}>`SELECT phase, failure_stage FROM chat_creation_operations`;
					if (mode === "legacy") expect(operations).toEqual([]);
					else expect(operations[0]?.failure_stage).toBeNull();
				}).pipe(Effect.provide(ChatCreate.pipe(Layer.provideMerge(services))));
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
