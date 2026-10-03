import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentItemId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	claudeForkPoint,
	claudeResumeOptions,
	matchesClaudeForkPoint,
} from "../../../src/drivers/claude-fork-point.ts";

const assistant = (extra = {}) =>
	({
		type: "assistant",
		uuid: "stable-uuid",
		session_id: "source-thread",
		parent_tool_use_id: null,
		message: { id: "message-1", content: [{ type: "text", text: "Answer" }] },
		...extra,
	}) as unknown as SDKMessage;

describe("Claude immutable native fork boundary", () => {
	it("correlates the last visible block and carries its SDK cutoff into resume", () => {
		const point = claudeForkPoint(assistant());
		expect(
			matchesClaudeForkPoint(point, {
				_tag: "assistant",
				itemId: AgentItemId.make("message-1:text:0"),
				text: "Answer",
			}),
		).toBe(true);
		expect(
			matchesClaudeForkPoint(point, {
				_tag: "assistant",
				itemId: AgentItemId.make("later:text:0"),
				text: "Later",
			}),
		).toBe(false);
		expect(claudeResumeOptions("source-thread", true, point)).toEqual({
			resume: "source-thread",
			forkSession: true,
			resumeSessionAt: "stable-uuid",
		});
		expect(claudeResumeOptions("fork-thread", false, point)).toEqual({
			resume: "fork-thread",
		});
	});
	it("does not infer a cutoff from subagents, tool-ending messages or legacy cursors", () => {
		expect(
			claudeForkPoint(assistant({ parent_tool_use_id: "agent-tool" })),
		).toBeNull();
		expect(
			claudeForkPoint(
				assistant({
					message: {
						id: "message-1",
						content: [
							{ type: "text", text: "Before tool" },
							{ type: "tool_use", id: "tool", name: "Read", input: {} },
						],
					},
				}),
			),
		).toBeNull();
		expect(() =>
			claudeResumeOptions("source-thread", true, "mutable-tail"),
		).toThrow("immutable assistant boundary");
		expect(claudeResumeOptions(null, false, null)).toEqual({});
	});
});
