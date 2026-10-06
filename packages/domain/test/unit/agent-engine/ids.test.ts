import { describe, expect, test } from "vitest";
import {
	derive,
	joinId,
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
			derive.providerThread({
				sessionId: "session-1",
				provider: "claude",
				nativeThreadId: "tool_1",
			}),
		).not.toBe(
			derive.providerThread({
				sessionId: "session-1",
				provider: "codex",
				nativeThreadId: "tool_1",
			}),
		);
	});

	test("id parts are percent-encoded so separators inside native ids cannot collide", () => {
		expect(joinId("a:b", "c")).toBe("a%3Ab:c");
		const a = derive.providerThread({
			sessionId: "session-1",
			provider: "codex",
			nativeThreadId: "x:y",
		});
		const b = derive.providerThread({
			sessionId: "session-1",
			provider: "codex",
			nativeThreadId: "x",
		});
		expect(a).not.toBe(b);
	});

	test("each attempt has its own root step", () => {
		const turnId = "turn_1";
		expect(derive.rootStep({ turnId, attemptOrdinal: 1 })).not.toBe(
			derive.rootStep({ turnId, attemptOrdinal: 2 }),
		);
	});
});
