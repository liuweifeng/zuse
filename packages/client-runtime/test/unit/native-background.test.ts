import {
	AgentItemId,
	Message,
	type MessageContent,
	MessageId,
	type SessionExecutionStep,
	SessionId,
} from "@zuse/contracts";
import { expect, it } from "vitest";
import { nativeBackgroundChildren } from "../../src/native-background.ts";

const message = (content: MessageContent): Message =>
	Message.make({
		id: MessageId.make(crypto.randomUUID()),
		sessionId: SessionId.make("s"),
		role: "assistant",
		content,
		createdAt: new Date(1),
	});
const progress = message({
	_tag: "subagent_progress",
	rootCompleted: true,
	childId: "child",
	parentId: "spawn",
	childSessionId: "native",
	status: "running",
	durationMs: 1,
	turns: 1,
	toolCalls: 0,
	tokens: 0,
	contextPercentage: 0,
	toolsUsed: [],
	errorCount: 0,
});
const step: SessionExecutionStep = {
	id: "step",
	turnId: "t",
	attemptId: "a",
	itemId: "spawn",
	parentItemId: null,
	kind: "subagent",
	label: "Agent",
	status: "running",
	childSessionId: "child",
	nativeChildId: "native",
	rootCompletedAt: 1,
	createdAt: 1,
	updatedAt: 1,
	checkpointCapability: "unsupported",
};
it("keeps subagent spawn acknowledgement distinct from completion", () => {
	const spawn = message({
		_tag: "tool_use",
		itemId: AgentItemId.make("spawn"),
		tool: "Agent",
		input: {},
		subagent: { childSessionId: "native", presentation: "detached" },
	});
	const acknowledgement = message({
		_tag: "tool_result",
		itemId: AgentItemId.make("spawn"),
		output: "started",
		isError: false,
	});
	expect([
		...nativeBackgroundChildren([spawn, progress, acknowledgement]),
	]).toEqual(["native"]);
	const finished = message({
		_tag: "subagent_summary",
		itemId: AgentItemId.make("spawn"),
		agentName: "Worker",
		model: "test",
		turns: 1,
		durationMs: 1,
		summary: "Done",
		isError: false,
	});
	expect([
		...nativeBackgroundChildren([spawn, progress, acknowledgement, finished]),
	]).toEqual([]);
});
it("uses durable steps when transcript pages omit terminal messages", () => {
	expect([...nativeBackgroundChildren([], [step])]).toEqual(["native"]);
	expect([
		...nativeBackgroundChildren([progress], [{ ...step, status: "cancelled" }]),
	]).toEqual([]);
});
it("ends a background shell task on its explicit tool result", () => {
	const spawn = message({
		_tag: "tool_use",
		itemId: AgentItemId.make("spawn"),
		tool: "Bash",
		input: {},
		backgroundTask: { taskId: "native" },
	});
	const result = message({
		_tag: "tool_result",
		itemId: AgentItemId.make("spawn"),
		output: "done",
		isError: false,
	});
	expect([...nativeBackgroundChildren([spawn, progress, result])]).toEqual([]);
});
