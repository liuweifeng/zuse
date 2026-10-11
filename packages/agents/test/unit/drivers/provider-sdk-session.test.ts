import {
	AgentNotFoundError,
	type Run,
	type SDKAgent,
	type SDKMessage,
} from "@cursor/sdk";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type {
	AgentEvent,
	AgentSessionId,
	AgentTurnId,
	AttachmentRef,
	FolderId,
	StartSessionInput,
} from "@zuse/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	create: vi.fn(),
	resume: vi.fn(),
}));

vi.mock("@cursor/sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cursor/sdk")>();
	return {
		...actual,
		Agent: { create: sdk.create, resume: sdk.resume },
	};
});

import { startCursorSession } from "../../../src/drivers/cursor.ts";
import {
	makeTurnScopedSessionHandle,
	type TurnScopedProviderEventEnvelope,
} from "../../../src/kernel/turn-protocol.ts";

const AttachmentsTest = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("not used"),
	saveText: () => Effect.die("not used"),
	read: () => Effect.succeed(null),
	readForSession: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});

const ImageAttachmentsTest = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("not used"),
	saveText: () => Effect.die("not used"),
	read: (id) =>
		Effect.succeed(
			id === "image-1"
				? { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }
				: null,
		),
	readForSession: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});

const input: StartSessionInput = {
	folderId: "folder-1" as FolderId,
	providerId: "cursor",
	mode: "sdk",
	model: "composer-2",
	permissionMode: "default",
};

const sessionId = "session-1" as AgentSessionId;

const deferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
};

const makeRun = (messages: SDKMessage[]): Run =>
	({
		id: "run-1",
		agentId: "agent-1",
		status: "finished",
		supports: () => true,
		unsupportedReason: () => undefined,
		async *stream() {
			for (const message of messages) yield message;
		},
		conversation: async () => [],
		wait: async () => ({ id: "run-1", status: "finished" }),
		cancel: vi.fn().mockResolvedValue(undefined),
		onDidChangeStatus: () => () => undefined,
	}) satisfies Run;

const makeAgent = () => {
	const send = vi.fn(async () =>
		makeRun([
			{
				type: "assistant",
				agent_id: "agent-1",
				run_id: "run-1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
				},
			},
		]),
	);
	return {
		agent: {
			agentId: "agent-1",
			model: { id: "composer-2" },
			send,
			close: vi.fn(),
			reload: vi.fn(),
			listArtifacts: vi.fn(),
			downloadArtifact: vi.fn(),
			[Symbol.asyncDispose]: vi.fn(),
		} as unknown as SDKAgent,
		send,
	};
};

const collectTurnEvents = async () => {
	const events: TurnScopedProviderEventEnvelope[] = [];
	await Effect.runPromise(
		Effect.gen(function* () {
			const raw = yield* startCursorSession(
				input,
				"/tmp/workspace",
				"managed-key",
				sessionId,
			);
			const handle = yield* makeTurnScopedSessionHandle(raw);
			const idle = deferred<void>();
			const fiber = yield* Stream.runForEach(handle.events, (event) =>
				Effect.sync(() => {
					events.push(event);
					if (event.event._tag === "Status" && event.event.status === "idle")
						idle.resolve();
				}),
			).pipe(Effect.forkChild);
			yield* handle.send("turn-1" as AgentTurnId, "yooo");
			yield* Effect.promise(() => idle.promise);
			yield* handle.close();
			yield* Fiber.join(fiber);
		}).pipe(Effect.provide(AttachmentsTest)),
	);
	return events;
};

describe("bundled provider SDK sessions", () => {
	beforeEach(() => {
		sdk.create.mockReset();
		sdk.resume.mockReset();
	});

	it("preserves the captured Cursor plan rejection through the turn boundary", async () => {
		const message =
			"Model unavailable on Start Start includes Composer 2.5, Grok 4.7, Grok 4.6, and Grok 4.5 with fixed settings. Switch to an included model to continue.";
		const fake = makeAgent();
		fake.send.mockResolvedValue({
			...makeRun([
				{
					type: "status",
					agent_id: "agent-1",
					run_id: "run-1",
					status: "ERROR",
					message,
				},
			]),
			wait: async () => ({ id: "run-1", status: "error", error: { message } }),
		});
		sdk.create.mockResolvedValue(fake.agent);
		const events = await collectTurnEvents();
		expect(events.filter((event) => event.event._tag === "Error")).toEqual([
			{
				scope: "turn",
				turnId: "turn-1",
				event: expect.objectContaining({
					_tag: "Error",
					message,
					providerId: "cursor",
				}),
			},
		]);
		expect(events.filter((event) => event.event._tag === "Completed")).toEqual([
			{
				scope: "turn",
				turnId: "turn-1",
				event: { _tag: "Completed", reason: "error" },
			},
		]);
	});

	it.each([
		["FINISHED", "finished", "ended"],
		["CANCELLED", "cancelled", "interrupted"],
	] as const)("waits for the %s result and retains trailing usage", async (status, resultStatus, reason) => {
		const fake = makeAgent();
		fake.send.mockResolvedValue({
			...makeRun([
				{ type: "status", agent_id: "agent-1", run_id: "run-1", status },
				{
					type: "usage",
					agent_id: "agent-1",
					run_id: "run-1",
					usage: {
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalTokens: 15,
					},
				},
			]),
			wait: async () => ({ id: "run-1", status: resultStatus }),
		});
		sdk.create.mockResolvedValue(fake.agent);
		const events = await collectTurnEvents();
		expect(events.filter((event) => event.event._tag === "Completed")).toEqual([
			{ scope: "turn", turnId: "turn-1", event: { _tag: "Completed", reason } },
		]);
		expect(events.filter((event) => event.event._tag === "UsageDelta")).toEqual(
			[
				{
					scope: "turn",
					turnId: "turn-1",
					event: expect.objectContaining({
						_tag: "UsageDelta",
						inputTokens: 10,
						outputTokens: 5,
					}),
				},
			],
		);
	});

	it("creates with the managed key and supports follow-up sends", async () => {
		const fake = makeAgent();
		sdk.create.mockResolvedValue(fake.agent);
		const events: AgentEvent[] = [];

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
					null,
					{
						name: "zuse",
						url: "http://127.0.0.1:4100/mcp",
						headers: { Authorization: "Bearer session-token" },
					},
				);
				const fiber = yield* Stream.runForEach(handle.events, (event) =>
					Effect.sync(() => events.push(event)),
				).pipe(Effect.forkChild);
				yield* handle.send("first");
				yield* Effect.sleep("20 millis");
				yield* handle.send("follow-up");
				yield* Effect.sleep("20 millis");
				yield* handle.close();
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(AttachmentsTest)),
		);

		expect(sdk.create).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "managed-key",
				local: expect.objectContaining({
					cwd: "/tmp/workspace",
					autoReview: true,
					sandboxOptions: { enabled: true },
					settingSources: ["project"],
				}),
			}),
		);
		expect(fake.send).toHaveBeenCalledTimes(2);
		expect(fake.send).toHaveBeenNthCalledWith(
			1,
			"first",
			expect.objectContaining({
				mode: "agent",
				mcpServers: {
					zuse: {
						type: "http",
						url: "http://127.0.0.1:4100/mcp",
						headers: { Authorization: "Bearer session-token" },
					},
				},
			}),
		);
		expect(events.some((event) => event._tag === "SessionCursor")).toBe(true);
		const assistantEvents = events.filter(
			(event) => event._tag === "AssistantMessage",
		);
		expect(
			assistantEvents.filter((event) => event.checkpoint?.final === true),
		).toHaveLength(2);
		expect(assistantEvents.at(-1)?.checkpoint).toEqual({
			revision: 2,
			final: true,
		});
	});

	it("publishes assistant progress before the SDK run finishes", async () => {
		const fake = makeAgent();
		const firstChunkYielded = deferred<void>();
		const progressObserved = deferred<void>();
		const releaseCompletion = deferred<void>();
		const run = {
			...makeRun([]),
			async *stream() {
				yield {
					type: "assistant",
					agent_id: "agent-1",
					run_id: "run-1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Working on it" }],
					},
				} satisfies SDKMessage;
				firstChunkYielded.resolve();
				await releaseCompletion.promise;
			},
		} satisfies Run;
		fake.send.mockResolvedValue(run);
		sdk.create.mockResolvedValue(fake.agent);
		const events: AgentEvent[] = [];

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
				);
				const fiber = yield* Stream.runForEach(handle.events, (event) =>
					Effect.sync(() => {
						events.push(event);
						if (
							event._tag === "AssistantMessage" &&
							event.text === "Working on it"
						) {
							progressObserved.resolve();
						}
					}),
				).pipe(Effect.forkChild);
				yield* handle.send("make progress visible");
				yield* Effect.promise(() => firstChunkYielded.promise);
				yield* Effect.promise(() => progressObserved.promise);

				expect(
					events.some(
						(event) =>
							event._tag === "AssistantMessage" &&
							event.text === "Working on it",
					),
				).toBe(true);

				releaseCompletion.resolve();
				yield* Effect.sleep("10 millis");
				yield* handle.close();
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(AttachmentsTest)),
		);
	});

	it("replaces a stale resumed agent and publishes the new cursor", async () => {
		const fake = makeAgent();
		sdk.resume.mockRejectedValue(new AgentNotFoundError("Agent not found"));
		sdk.create.mockResolvedValue(fake.agent);
		const events: AgentEvent[] = [];

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
					"stale-agent",
				);
				const fiber = yield* Stream.runForEach(handle.events, (event) =>
					Effect.sync(() => events.push(event)),
				).pipe(Effect.forkChild);
				yield* Effect.sleep("10 millis");
				yield* handle.close();
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(AttachmentsTest)),
		);

		expect(sdk.resume).toHaveBeenCalledWith("stale-agent", expect.any(Object));
		expect(sdk.create).toHaveBeenCalledOnce();
		expect(
			events.find((event) => event._tag === "SessionCursor"),
		).toMatchObject({ cursor: "agent-1" });
	});

	it("cancels a run that resolves after interruption", async () => {
		const fake = makeAgent();
		const run = makeRun([]);
		const cancel = vi.spyOn(run, "cancel");
		let resolveSend: ((value: Run) => void) | undefined;
		fake.send.mockImplementation(
			() => new Promise<Run>((resolve) => (resolveSend = resolve)),
		);
		sdk.create.mockResolvedValue(fake.agent);

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
				);
				yield* handle.send("start slowly");
				yield* Effect.sleep("5 millis");
				yield* handle.interrupt();
				resolveSend?.(run);
				yield* Effect.sleep("20 millis");
				yield* handle.close();
			}).pipe(Effect.provide(AttachmentsTest)),
		);

		expect(cancel).toHaveBeenCalledOnce();
	});

	it("passes image inputs, plan mode, and only the Zuse gateway MCP to new runs", async () => {
		const fake = makeAgent();
		sdk.create.mockResolvedValue(fake.agent);
		const image: AttachmentRef = {
			id: "image-1",
			mimeType: "image/png",
			originalName: "screen.png",
		};

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
					null,
					{
						name: "zuse",
						url: "http://127.0.0.1:4100/mcp",
						headers: { Authorization: "Bearer session-token" },
					},
				);
				yield* handle.setPermissionMode("plan");
				yield* handle.send("inspect this", [image]);
				yield* Effect.sleep("20 millis");
				yield* handle.close();
			}).pipe(Effect.provide(ImageAttachmentsTest)),
		);

		expect(fake.send).toHaveBeenCalledWith(
			{
				text: "inspect this",
				images: [{ data: "AQID", mimeType: "image/png" }],
			},
			expect.objectContaining({
				mode: "plan",
				mcpServers: {
					zuse: {
						type: "http",
						url: "http://127.0.0.1:4100/mcp",
						headers: { Authorization: "Bearer session-token" },
					},
				},
			}),
		);
	});

	it("always overrides native Cursor MCP config, even without a gateway", async () => {
		const fake = makeAgent();
		sdk.create.mockResolvedValue(fake.agent);

		await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* startCursorSession(
					input,
					"/tmp/workspace",
					"managed-key",
					sessionId,
				);
				yield* handle.send("hello", []);
				yield* Effect.sleep("20 millis");
				yield* handle.close();
			}).pipe(Effect.provide(ImageAttachmentsTest)),
		);

		expect(fake.send).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ mcpServers: {} }),
		);
	});
});
