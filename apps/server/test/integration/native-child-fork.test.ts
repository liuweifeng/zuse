import { SessionId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import {
	captureNativeChildFork,
	prepareNativeChildTranscript,
} from "../../src/conversation/core/native-child-fork.ts";
import { nativeChildThread as thread } from "../support/native-child-thread.ts";

test("portable child transcript uses full actual input/output and stable identities", () => {
	const original = thread();
	const frozen = JSON.stringify(original);
	const messages = prepareNativeChildTranscript(original, "parent");
	expect(messages.map((message) => message.content)).toMatchObject([
		{ _tag: "user", text: "child assignment" },
		{ _tag: "assistant", text: "child actual output" },
	]);
	expect(prepareNativeChildTranscript(original, "parent")).toEqual(messages);
	expect(JSON.stringify(original)).toBe(frozen);
});

test("rejects foreign lineage, incomplete history, active child and unsupported input instead of substituting summary", () => {
	expect(() => prepareNativeChildTranscript(thread(), "other-parent")).toThrow(
		/lineage/,
	);
	const active = thread();
	active.status = { type: "active", activeFlags: [] };
	expect(() => prepareNativeChildTranscript(active, "parent")).toThrow(/idle/);
	const incomplete = thread();
	const incompleteTurn = incomplete.turns[0];
	if (incompleteTurn === undefined) throw new Error("Missing fixture turn");
	incompleteTurn.itemsView = "summary";
	expect(() => prepareNativeChildTranscript(incomplete, "parent")).toThrow(
		/incomplete/,
	);
	const nested = thread();
	const nestedTurn = nested.turns[0];
	if (nestedTurn === undefined) throw new Error("Missing fixture turn");
	nestedTurn.items.push({
		type: "collabAgentToolCall",
		id: "nested",
		tool: "spawnAgent",
		status: "completed",
		senderThreadId: "child",
		receiverThreadIds: ["grandchild"],
		prompt: "nested",
		model: null,
		reasoningEffort: null,
		agentsStates: {},
	});
	expect(() => prepareNativeChildTranscript(nested, "parent")).toThrow(
		/unverified nested work/,
	);
	const images = thread();
	const imageTurn = images.turns[0];
	if (imageTurn === undefined) throw new Error("Missing fixture turn");
	imageTurn.items = [
		{
			type: "userMessage",
			id: "image",
			content: [{ type: "image", url: "secret-image" }],
		},
	];
	expect(() => prepareNativeChildTranscript(images, "parent")).toThrow(
		/non-text/,
	);
});

test("native child reads are authorized by exact completed step and original provider attempt", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE session_execution_steps(id TEXT,session_id TEXT,attempt_id TEXT,turn_id TEXT,native_child_id TEXT,status TEXT,kind TEXT)`;
			yield* sql`CREATE TABLE session_attempts(id TEXT,session_id TEXT,turn_id TEXT,provider_turn_json TEXT)`;
			yield* sql`INSERT INTO session_execution_steps VALUES('step','source','attempt','turn','child','completed','subagent')`;
			yield* sql`INSERT INTO session_attempts VALUES('attempt','source','turn',${JSON.stringify({ provider: "codex", nativeThreadId: "parent", nativeTurnId: "root-turn" })})`;
			let reads = 0;
			const inspect = () =>
				Effect.sync(() => {
					reads++;
					return thread();
				});
			const captured = yield* captureNativeChildFork(
				sql,
				SessionId.make("source"),
				"step",
				inspect,
			);
			expect(captured).toHaveLength(2);
			expect(reads).toBe(1);
			expect(
				(yield* captureNativeChildFork(
					sql,
					SessionId.make("foreign"),
					"step",
					inspect,
				).pipe(Effect.result))._tag,
			).toBe("Failure");
			expect(reads).toBe(1);
			yield* sql`UPDATE session_execution_steps SET status='running'`;
			expect(
				(yield* captureNativeChildFork(
					sql,
					SessionId.make("source"),
					"step",
					inspect,
				).pipe(Effect.result))._tag,
			).toBe("Failure");
			expect(reads).toBe(1);
			yield* sql`UPDATE session_execution_steps SET status='completed'`;
			yield* sql`UPDATE session_attempts SET provider_turn_json=${JSON.stringify({ provider: "claude", nativeThreadId: "parent", nativeTurnId: "root-turn" })}`;
			expect(
				(yield* captureNativeChildFork(
					sql,
					SessionId.make("source"),
					"step",
					inspect,
				).pipe(Effect.result))._tag,
			).toBe("Failure");
			expect(reads).toBe(1);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
