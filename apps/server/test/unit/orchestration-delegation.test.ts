import {
	Chat,
	ChatId,
	FolderId,
	type Session,
	SessionId,
	WorktreeId,
} from "@zuse/contracts";
import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	type ConversationOrchestrationDependencies,
	makeConversationOrchestration,
} from "../../src/conversation/core/conversation-orchestration.ts";

const parentId = SessionId.make("parent");
const chatId = ChatId.make("chat");
const projectId = FolderId.make("project");
const fixture = async () => {
	const parent = {
		id: parentId,
		chatId,
		projectId,
		worktreeId: null,
		providerId: "codex",
		model: "model",
		runtimeMode: "approval-required",
		permissionMode: "default",
		status: "running",
		title: "Parent",
		archivedAt: null,
	} as Session;
	const children = new Map<string, Session>();
	const parents = new Map<string, string>();
	const prompts = new Map<string, string>();
	const calls: Array<
		Parameters<ConversationOrchestrationDependencies["createSession"]>[0]
	> = [];
	const deps: ConversationOrchestrationDependencies = {
		runtime: Context.empty(),
		persistMessage: () => Effect.die("Unexpected persistence"),
		captureDelegation: () =>
			Effect.succeed({
				parentSessionId: parentId,
				parentTurnId: "turn",
				parentAttemptId: "attempt",
				providerSessionId: "native",
			}),
		getSettings: () => Effect.fail(new Error("unused")),
		getModelCatalog: () => Effect.fail(new Error("unused")),
		createWorktree: () => Effect.fail(new Error("unused")),
		createChat: () => Effect.fail(new Error("unused")),
		createSession: (input) =>
			Effect.sync(() => {
				calls.push(input);
				if (!input.sessionId || !input.runtimeMode || !input.permissionMode)
					throw new Error("Missing child admission fields");
				const child = {
					...parent,
					id: input.sessionId,
					runtimeMode: input.runtimeMode,
					permissionMode: input.permissionMode,
					status: "booting" as const,
				};
				children.set(child.id, child);
				parents.set(child.id, input.delegation.parentSessionId);
				prompts.set(child.id, input.initialPrompt);
				return child;
			}),
		getChat: () => Effect.fail(new Error("unused")),
		getSession: (id) => {
			const found = id === parentId ? parent : children.get(id);
			return found ? Effect.succeed(found) : Effect.fail(new Error("missing"));
		},
		sendToSession: () => Effect.void,
		listMessages: (id) =>
			Effect.succeed([
				{ content: { _tag: "user", text: prompts.get(id) } },
			] as never),
		listChats: () =>
			Effect.succeed([
				Chat.make({
					id: chatId,
					projectId,
					worktreeId: null,
					title: "Shared chat",
					titleProvenance: "manual",
					activeSessionId: parentId,
					originSessionId: null,
					archivedAt: null,
					lastMessageAt: null,
					lastReadAt: null,
					createdAt: new Date(0),
					updatedAt: new Date(0),
				}),
			]),
		listSessions: (_projectId, includeArchived) =>
			Effect.succeed(
				[parent, ...children.values()].filter(
					(session) => includeArchived || session.archivedAt === null,
				),
			),
		tasks: {
			listParents: () =>
				Effect.succeed(
					[...parents].map(([sessionId, parentSessionId]) => ({
						sessionId,
						parentSessionId,
					})),
				),
			assertSendable: () => Effect.succeed(undefined),
			status: (_parent, id) =>
				Effect.succeed(
					children.has(id)
						? {
								ok: true,
								taskId: id,
								sessionId: id,
								status: "running",
								workState: "working",
							}
						: { ok: false, error: "missing" },
				),
			cancel: () => Effect.fail(new Error("unused")),
		},
	};
	const tools = await Effect.runPromise(
		makeConversationOrchestration(deps, {
			sessionId: parentId,
			chatId,
			projectId,
			worktreeId: null,
			providerId: "codex",
			model: "model",
		}),
	);
	if (!tools.deps.delegateTask) throw new Error("Missing delegation tool");
	return {
		tools: { ...tools.deps, delegateTask: tools.deps.delegateTask },
		calls,
		parent,
		children,
		parents,
		deps,
	};
};
describe("managed delegation admission", () => {
	it("retries return the same durable child, carrying only explicit task context and parent permissions", async () => {
		const { tools, calls, parent } = await fixture();
		const input = {
			clientRequestId: "review-1",
			task: "Review the parser",
			role: "Check error paths",
		};
		const first = await tools.delegateTask(input);
		const second = await tools.delegateTask(input);
		expect(first.ok && second.ok && first.taskId === second.taskId).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			initialPrompt: "Check error paths\n\nReview the parser",
			runtimeMode: parent.runtimeMode,
			permissionMode: parent.permissionMode,
			originSessionId: parentId,
			background: true,
		});
		expect(calls[0]?.initialTurnId).toBeTruthy();
		expect(calls[0]?.initialMessageId).toBeTruthy();
	});
	it("uses current model settings for new tasks while retries keep their original selection", async () => {
		const { tools, calls, parent } = await fixture();
		const original = await tools.delegateTask({
			clientRequestId: "original",
			task: "Review",
		});
		Object.assign(parent, { model: "new-model" });
		const retry = await tools.delegateTask({
			clientRequestId: "original",
			task: "Review",
		});
		expect(original.ok && retry.ok && original.taskId === retry.taskId).toBe(
			true,
		);
		await tools.delegateTask({ clientRequestId: "next", task: "Next review" });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.model).toBe("new-model");
	});

	it("rejects reusing a request id for a different task", async () => {
		const { tools, calls } = await fixture();
		await tools.delegateTask({ clientRequestId: "same", task: "First" });
		expect(
			await tools.delegateTask({ clientRequestId: "same", task: "Different" }),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("different task"),
		});
		expect(calls).toHaveLength(1);
	});
});

it("discovers background child tabs even when their parent remains the active chat session", async () => {
	const { tools } = await fixture();
	const first = await tools.delegateTask({
		clientRequestId: "one",
		task: "Review",
	});
	const second = await tools.delegateTask({
		clientRequestId: "two",
		task: "Test",
	});
	if (!first.ok || !second.ok) throw new Error("Delegation failed");
	const listed = await tools.listThreads({});
	expect(listed).toMatchObject({
		ok: true,
		threads: [
			{ sessionId: parentId, chatId, spawnedByMe: false },
			{
				sessionId: first.sessionId,
				chatId,
				spawnedByMe: true,
				parentSessionId: parentId,
			},
			{
				sessionId: second.sessionId,
				chatId,
				spawnedByMe: true,
				parentSessionId: parentId,
			},
		],
	});
});

it("discovers archived child tabs only when explicitly requested", async () => {
	const { tools, children } = await fixture();
	const child = await tools.delegateTask({
		clientRequestId: "archived",
		task: "Review",
	});
	if (!child.ok) throw new Error("Delegation failed");
	const stored = children.get(child.sessionId);
	if (!stored) throw new Error("Missing child");
	Object.assign(stored, { archivedAt: new Date(1) });
	expect(await tools.listThreads({})).toMatchObject({
		ok: true,
		threads: [{ sessionId: parentId }],
	});
	expect(await tools.listThreads({ includeArchived: true })).toMatchObject({
		ok: true,
		threads: [{ sessionId: parentId }, { sessionId: child.sessionId }],
	});
});

it("distinguishes isolated children and nested tasks from human tabs in a spawned chat", async () => {
	const { tools, deps, children, parents } = await fixture();
	const child = await tools.delegateTask({
		clientRequestId: "isolated",
		task: "Review",
	});
	const nested = await tools.delegateTask({
		clientRequestId: "nested",
		task: "Test",
	});
	if (!child.ok || !nested.ok) throw new Error("Delegation failed");
	const isolatedChatId = ChatId.make("isolated-chat");
	const worktreeId = WorktreeId.make("worktree");
	const childSession = children.get(child.sessionId);
	if (!childSession) throw new Error("Missing child");
	Object.assign(childSession, {
		chatId: isolatedChatId,
		worktreeId,
		title: "Child review",
	});
	parents.set(nested.sessionId, child.sessionId);
	const manualId = SessionId.make("human-tab");
	children.set(manualId, { ...childSession, id: manualId, title: "Human tab" });
	const chats = await Effect.runPromise(deps.listChats(projectId, false));
	const currentChat = chats[0];
	if (!currentChat) throw new Error("Missing chat");
	Object.assign(deps, {
		listChats: () =>
			Effect.succeed([
				...chats,
				Chat.make({
					...currentChat,
					id: isolatedChatId,
					worktreeId,
					activeSessionId: manualId,
					originSessionId: parentId,
				}),
			]),
	});
	expect(await tools.listThreads({})).toMatchObject({
		ok: true,
		threads: [
			{ sessionId: parentId, spawnedByMe: false, parentSessionId: null },
			{
				sessionId: child.sessionId,
				chatId: isolatedChatId,
				worktreeId,
				title: "Child review",
				spawnedByMe: true,
				parentSessionId: parentId,
			},
			{
				sessionId: nested.sessionId,
				spawnedByMe: false,
				parentSessionId: child.sessionId,
			},
			{
				sessionId: manualId,
				chatId: isolatedChatId,
				spawnedByMe: false,
				parentSessionId: null,
				chatOriginSessionId: parentId,
			},
		],
	});
});
