import { describe, expect, it, vi } from "vitest";
import {
	CodexThreadReadError,
	readCodexThread,
	readCodexTurnEvidence,
} from "../../../src/drivers/codex-thread-reader.ts";

const reference = {
	provider: "codex" as const,
	nativeThreadId: "thread-1",
	nativeTurnId: "turn-1",
};
const turn = {
	id: "turn-1",
	items: [{ type: "agentMessage", id: "output-1", text: "Recovered output" }],
	itemsView: "full",
	status: "completed",
	error: null,
	startedAt: 100,
	completedAt: 101,
	durationMs: 1000,
};
const clientFor = (response: unknown) => {
	const calls = vi.fn();
	return {
		calls,
		request: async <T>(
			method: string,
			params: unknown,
			options?: { timeoutMs: number },
		): Promise<T> => {
			calls(method, params, options);
			return response as T;
		},
	};
};
const responseFor = (turns: unknown[], id = "thread-1") => ({
	thread: { id, turns },
});

describe("native transcript evidence", () => {
	it.each([
		"completed",
		"failed",
		"interrupted",
	])("reads exact %s execution without resuming or sending", async (status) => {
		const execution = { ...turn, status };
		const client = clientFor(
			responseFor([{ ...turn, id: "other-turn" }, execution]),
		);
		expect(await readCodexTurnEvidence(client, reference)).toEqual({
			kind: "terminal",
			turn: execution,
		});
		expect(client.calls.mock.calls).toEqual([
			[
				"thread/read",
				{ threadId: "thread-1", includeTurns: true },
				{ timeoutMs: 10_000 },
			],
		]);
	});
	it.each([
		"notLoaded",
		"summary",
		undefined,
	])("does not treat %s output as complete", async (itemsView) => {
		expect(
			await readCodexTurnEvidence(
				clientFor(responseFor([{ ...turn, itemsView }])),
				reference,
			),
		).toEqual({ kind: "incomplete" });
	});
	it("keeps running executions distinct from terminal evidence", async () => {
		expect(
			await readCodexTurnEvidence(
				clientFor(responseFor([{ ...turn, status: "inProgress" }])),
				reference,
			),
		).toEqual({ kind: "running" });
	});
	it("never matches executions by prompt, order, or latest turn", async () => {
		expect(
			await readCodexTurnEvidence(
				clientFor(responseFor([{ ...turn, id: "another-turn" }])),
				reference,
			),
		).toEqual({ kind: "missing" });
	});
	it.each([
		responseFor([turn], "other-thread"),
		responseFor([turn, turn]),
		responseFor([{ ...turn, items: null }]),
		responseFor([{ ...turn, status: "unknown" }]),
		{ thread: { id: "thread-1", turns: null } },
		null,
	])("rejects contradictory or malformed evidence", async (response) => {
		await expect(
			readCodexTurnEvidence(clientFor(response), reference),
		).rejects.toMatchObject({ reason: "invalid_response" });
	});
	it("does not expose transport errors or convert failed reads to missing evidence", async () => {
		const client = {
			request: async <T>(): Promise<T> => {
				throw new Error("secret provider credential");
			},
		};
		await expect(readCodexTurnEvidence(client, reference)).rejects.toEqual(
			new CodexThreadReadError("read_failed"),
		);
	});
	it("rejects another provider before opening a transcript", async () => {
		const client = clientFor(responseFor([turn]));
		await expect(
			readCodexTurnEvidence(client, { ...reference, provider: "claude" }),
		).rejects.toMatchObject({ reason: "invalid_response" });
		expect(client.calls).not.toHaveBeenCalled();
	});
	it("shares the exact thread identity check with transcript import", async () => {
		await expect(
			readCodexThread(clientFor(responseFor([], "wrong")), "thread-1"),
		).rejects.toMatchObject({ reason: "invalid_response" });
	});
});

it.each([
	{
		type: "collabAgentToolCall",
		id: "spawn",
		tool: "spawnAgent",
		status: "completed",
		receiverThreadIds: ["child"],
		agentsStates: { child: { status: "running", message: null } },
	},
	{
		type: "collabAgentToolCall",
		id: "wait",
		tool: "wait",
		status: "completed",
		receiverThreadIds: ["child"],
		agentsStates: {
			child: {
				status: "completed",
				message: "Child summary without exact execution output",
			},
		},
	},
	{
		type: "subAgentActivity",
		id: "child-start",
		kind: "started",
		agentThreadId: "child",
		agentPath: "/child",
	},
	{
		type: "subAgentActivity",
		id: "child-interrupted",
		kind: "interrupted",
		agentThreadId: "child",
		agentPath: "/child",
	},
])("does not infer child completion from a terminal parent containing $type", async (child) => {
	const client = clientFor(
		responseFor([{ ...turn, items: [...turn.items, child] }]),
	);
	expect(await readCodexTurnEvidence(client, reference)).toEqual({
		kind: "incomplete",
		reason: "native_children",
	});
	expect(client.calls).toHaveBeenCalledTimes(1);
});
