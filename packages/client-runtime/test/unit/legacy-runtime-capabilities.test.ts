import { SessionAlreadyStartedError, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	supportsIdempotentSessionFork,
	supportsRuntimeRpc,
	withRuntimeRpcCompatibility,
} from "../../src/legacy-runtime-capabilities.ts";

describe("legacy runtime RPC capability boundary", () => {
	it("never transmits unsupported mutations", async () => {
		const send = vi.fn(() => Effect.void);
		const client = withRuntimeRpcCompatibility(
			{
				"session.checkpoints.restore": send,
				"session.mergeBack": send,
				"schedule.create": send,
				"session.sendAndWait": send,
			},
			6,
		);
		for (const call of Object.values(client)) {
			const result = await Effect.runPromise(Effect.result(call()));
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "UnsupportedRuntimeFeatureError",
					message:
						"This feature needs a newer workspace runtime. You can continue using this chat without updating.",
				},
			});
		}
		expect(send).not.toHaveBeenCalled();
	});
	it("preserves send, stop, queue and read effects without replay", () => {
		const effect = Effect.succeed("ok");
		const call = vi.fn(() => effect);
		const client = withRuntimeRpcCompatibility(
			{
				"messages.send": call,
				"messages.interrupt": call,
				"messages.queue.add": call,
				"session.get": call,
			},
			5,
		);
		for (const method of Object.values(client)) expect(method()).toBe(effect);
		expect(call).toHaveBeenCalledTimes(4);
	});
	it("blocks new native child fork semantics on old runtimes", async () => {
		const call = vi.fn((_input: { nativeChildStepId?: string }) => Effect.void);
		const client = withRuntimeRpcCompatibility({ "session.fork": call }, 6);
		const result = await Effect.runPromise(
			Effect.result(client["session.fork"]({ nativeChildStepId: "child" })),
		);
		expect(result._tag).toBe("Failure");
		expect(call).not.toHaveBeenCalled();
		await Effect.runPromise(client["session.fork"]({}));
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("explains legacy provider switching without retrying or rewriting other errors", async () => {
		const rejected = new SessionAlreadyStartedError({
			sessionId: SessionId.make("old-session"),
		});
		const send = vi.fn(() => Effect.fail(rejected));
		const client = withRuntimeRpcCompatibility(
			{ "session.setProvider": send, "session.setWorktree": send },
			6,
		);
		const switched = await Effect.runPromise(
			Effect.result(client["session.setProvider"]()),
		);
		expect(switched).toMatchObject({
			_tag: "Failure",
			failure: {
				message:
					"This runtime can change models within the current provider. Start a new chat or update the workspace runtime to switch providers.",
			},
		});
		const worktree = await Effect.runPromise(
			Effect.result(client["session.setWorktree"]()),
		);
		if (worktree._tag !== "Failure") throw new Error("Expected rejection");
		expect(worktree.failure).toBe(rejected);
		expect(send).toHaveBeenCalledTimes(2);
		const unrelated = new Error("Connection unavailable");
		const other = withRuntimeRpcCompatibility(
			{ "session.setProvider": () => Effect.fail(unrelated) },
			6,
		);
		const result = await Effect.runPromise(
			Effect.result(other["session.setProvider"]()),
		);
		if (result._tag !== "Failure") throw new Error("Expected failure");
		expect(result.failure).toBe(unrelated);
	});

	it("permits retrying a fork only when the runtime honors its command identity", () => {
		for (const version of [undefined, 5, 6])
			expect(supportsIdempotentSessionFork(version)).toBe(false);
		expect(supportsIdempotentSessionFork(7)).toBe(true);
	});

	it("keeps chunk uploads versioned and leaves current clients unchanged", () => {
		expect(supportsRuntimeRpc("attachments.uploadChunk", 5)).toBe(false);
		expect(supportsRuntimeRpc("attachments.uploadChunk", 6)).toBe(true);
		expect(supportsRuntimeRpc("session.attempts.list", 6)).toBe(false);
		expect(supportsRuntimeRpc("provider.acp.install", 5)).toBe(false);
		expect(supportsRuntimeRpc("modelConnections.connect", 5)).toBe(false);
		expect(supportsRuntimeRpc("session.get", undefined)).toBe(false);
		const client = {};
		expect(withRuntimeRpcCompatibility(client, 7)).toBe(client);
	});
});
