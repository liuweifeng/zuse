import { AgentItemId, type Message, type SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { deriveSubagentTimelineRows } from "../../src/lib/subagent-transcript.ts";

const sessionId = "session-subagent" as SessionId;
const parentItemId = AgentItemId.make("agent-1");

function message(id: string, content: Message["content"]): Message {
	return {
		id,
		sessionId,
		role: "assistant",
		content,
		createdAt: new Date("2026-10-15T00:00:00.000Z"),
	} as Message;
}

const parent = message("agent", {
	_tag: "tool_use",
	itemId: parentItemId,
	tool: "Agent",
	input: { prompt: "Trace runtime selection" },
});

const child = (id: string, content: Message["content"]): Message =>
	message(id, { ...content, parentItemId } as Message["content"]);

const work = [
	child("thinking", {
		_tag: "thinking",
		itemId: AgentItemId.make("thinking-1"),
		text: "Let me look",
		redacted: false,
	}),
	child("bash-1", {
		_tag: "tool_use",
		itemId: AgentItemId.make("bash-1"),
		tool: "Bash",
		input: { command: "ls" },
	}),
	child("bash-1-result", {
		_tag: "tool_result",
		itemId: AgentItemId.make("bash-1"),
		output: "apps",
		isError: false,
	}),
	child("read-1", {
		_tag: "tool_use",
		itemId: AgentItemId.make("read-1"),
		tool: "Read",
		input: { file_path: "a.ts" },
	}),
];

describe("subagent transcript rows", () => {
	it("gathers a working run's tools into one live activity tree", () => {
		const rows = deriveSubagentTimelineRows({
			parent,
			parentItemId,
			children: work,
			summaryText: null,
			live: true,
		});

		expect(rows.map((row) => row.kind)).toEqual(["tool-activity"]);
		expect(rows[0]).toMatchObject({ live: true });
	});

	it("collapses a finished run behind its summary", () => {
		const rows = deriveSubagentTimelineRows({
			parent,
			parentItemId,
			children: work,
			summaryText: "Runtime comes from the account image",
			live: false,
		});

		expect(rows.map((row) => row.kind)).toEqual(["turn-summary"]);
		const summary = rows[0];
		if (summary?.kind !== "turn-summary") throw new Error("expected summary");
		const final = summary.body.at(-1);
		expect(final?.content).toEqual({
			_tag: "assistant",
			text: "Runtime comes from the account image",
		});
	});

	it("does not repeat a summary the agent already wrote", () => {
		const rows = deriveSubagentTimelineRows({
			parent,
			parentItemId,
			children: [...work, child("reply", { _tag: "assistant", text: "Done" })],
			summaryText: "Done",
			live: false,
		});

		const summary = rows[0];
		if (summary?.kind !== "turn-summary") throw new Error("expected summary");
		expect(
			summary.body.filter((item) => item.content._tag === "assistant"),
		).toHaveLength(1);
	});

	it("keeps a settled run without a final reply in full", () => {
		const rows = deriveSubagentTimelineRows({
			parent,
			parentItemId,
			children: work,
			summaryText: null,
			live: false,
		});

		expect(rows.map((row) => row.kind)).toEqual(["tool-activity"]);
		expect(rows[0]).toMatchObject({ live: false });
	});

	it("keeps re-rooted messages stable across derivations", () => {
		const derive = () =>
			deriveSubagentTimelineRows({
				parent,
				parentItemId,
				children: work,
				summaryText: null,
				live: true,
			})[0];
		const first = derive();
		const second = derive();
		if (first?.kind !== "tool-activity" || second?.kind !== "tool-activity") {
			throw new Error("expected activity");
		}
		expect(second.messages[1]).toBe(first.messages[1]);
	});
});
