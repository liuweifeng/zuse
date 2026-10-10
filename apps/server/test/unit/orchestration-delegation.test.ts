import { ChatId, FolderId, type Session, SessionId } from "@zuse/contracts";
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
	} as Session;
	const children = new Map<string, Session>();
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
		listChats: () => Effect.succeed([]),
		listSessions: () => Effect.succeed([]),
		tasks: {
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
