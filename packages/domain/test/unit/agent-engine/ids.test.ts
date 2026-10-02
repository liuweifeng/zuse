import { describe, expect, test } from "vitest";
import {
	derive,
	joinId,
	makeIdAllocator,
	scopeProviderThreadId,
} from "../../../src/agent-engine/ids.js";

describe("agent engine ids", () => {
	test("normalizes historical thread ids once per owning session", () => {
		const historical = "provider-thread:provider:codex:native-thread:shared";
		const parent = scopeProviderThreadId("parent", historical);
		expect(scopeProviderThreadId("parent", parent)).toBe(parent);
		expect(scopeProviderThreadId("fork", historical)).not.toBe(parent);
		expect(
			derive.providerThread({
				sessionId: "parent",
				provider: "codex",
				nativeThreadId: "shared",
			}),
		).toBe(parent);
	});

	test("derived ids are deterministic and content-addressed", () => {
		const first = derive.providerThread({
			sessionId: "session-1",
			provider: "codex",
			nativeThreadId: "thread-1",
		});
		const second = derive.providerThread({
			sessionId: "session-1",
			provider: "codex",
			nativeThreadId: "thread-1",
		});
		expect(first).toBe(second);
		expect(first).toBe(
			"provider-thread:session:session-1:provider-thread%3Aprovider%3Acodex%3Anative-thread%3Athread-1",
		);
	});

	test("the same native id under a different provider derives a different app id", () => {
		expect(
			derive.timelineItemFromProviderItem({
				provider: "claude",
				nativeItemId: "tool_1",
			}),
		).not.toBe(
			derive.timelineItemFromProviderItem({
				provider: "codex",
				nativeItemId: "tool_1",
			}),
		);
	});

	test("id parts are percent-encoded so separators inside native ids cannot collide", () => {
		expect(joinId("a:b", "c")).toBe("a%3Ab:c");
		const a = derive.providerTurn({ provider: "codex", nativeTurnId: "x:y" });
		const b = derive.providerTurn({ provider: "codex", nativeTurnId: "x" });
		expect(a).not.toBe(b);
	});

	test("turn signal items pair by turn id", () => {
		const turnId = derive.turn({ sessionId: "s_1", ordinal: 3 });
		expect(
			derive.turnSignalTimelineItem({ turnId, signal: "interrupt-requested" }),
		).toBe(
			"timeline:turn:turn%3Asession%3As_1%3Aordinal%3A3:interrupt-requested",
		);
		expect(
			derive.turnSignalTimelineItem({ turnId, signal: "interrupt-result" }),
		).not.toBe(
			derive.turnSignalTimelineItem({ turnId, signal: "interrupt-requested" }),
		);
	});

	test("each attempt has its own root step", () => {
		const turnId = derive.turn({ sessionId: "s_1", ordinal: 1 });
		expect(derive.rootStep({ turnId, attemptOrdinal: 1 })).not.toBe(
			derive.rootStep({ turnId, attemptOrdinal: 2 }),
		);
	});

	test("jobs derive from the requesting command so retries collapse", () => {
		const job = derive.job({
			commandId: "cmd_1",
			kind: "provider.turn.start",
			target: "turn_1",
		});
		expect(job).toBe("job:cmd_1:provider.turn.start:turn_1");
		expect(
			derive.job({
				commandId: "cmd_1",
				kind: "provider.turn.start",
				target: "turn_1",
			}),
		).toBe(job);
	});

	test("allocated ids use the injected id source", () => {
		let counter = 0;
		const allocator = makeIdAllocator(() => `uuid-${++counter}`);
		expect(allocator.turn("s_1")).toBe("turn:session:s_1:uuid-1");
		expect(allocator.turn("s_1")).toBe("turn:session:s_1:uuid-2");
		expect(allocator.providerThread("claude")).toBe(
			"provider-thread:provider:claude:uuid-3",
		);
	});
});
