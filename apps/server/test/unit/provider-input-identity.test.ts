import type {
	ProviderDriverEvent,
	ProviderSessionHandle,
} from "@zuse/agents/kernel/driver";
import {
	AgentItemId,
	AgentSessionNotFoundError,
	SessionId,
} from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import {
	lookupDurableQuestionResolution,
	settleDurableQuestionResolution,
} from "../../src/conversation/core/question-resolution-receipt.ts";
import { ownProviderInputs } from "../../src/provider/provider-input-identity.ts";

const nativeId = AgentItemId.make("native-question");
const parentItemId = AgentItemId.make("parent-tool");
const question = {
	_tag: "UserQuestion",
	itemId: nativeId,
	parentItemId,
	questions: [{ question: "Continue?", options: ["Yes", "No"] }],
} as const;
const answers = [{ questionIndex: 0, selected: [0] }];

const fixture = (
	close = Effect.void,
	planEffect: Effect.Effect<void, Error> = Effect.void,
) =>
	Effect.gen(function* () {
		const input = yield* Queue.unbounded<ProviderDriverEvent>();
		const output = yield* Queue.unbounded<ProviderDriverEvent>();
		const delivered: string[] = [];
		const raw: ProviderSessionHandle = {
			events: Stream.fromQueue(input),
			send: () => Effect.void,
			interrupt: () => Effect.void,
			close: () => close,
			setPermissionMode: () => Effect.void,
			answerQuestion: (itemId) =>
				Effect.sync(() => {
					delivered.push(`answer:${itemId}`);
				}),
			cancelQuestion: (itemId) =>
				Effect.sync(() => {
					delivered.push(`cancel:${itemId}`);
				}),
			respondToPlan: (itemId, outcome) =>
				Effect.sync(() => {
					delivered.push(`plan:${itemId}:${outcome}`);
				}).pipe(Effect.andThen(planEffect)),
			acknowledgeQuestionAnswer: (itemId) =>
				Effect.sync(() => {
					delivered.push(`ack:${itemId}`);
				}),
		};
		const handle = ownProviderInputs(raw);
		yield* handle.events.pipe(
			Stream.runForEach((event) => Queue.offer(output, event)),
			Effect.forkScoped,
		);
		const publish = (event: ProviderDriverEvent) =>
			Queue.offer(input, event).pipe(Effect.andThen(Queue.take(output)));
		const ask = Effect.gen(function* () {
			const event = yield* publish(question);
			if (event._tag !== "UserQuestion") throw new Error("Expected question");
			expect(event.questions).toEqual(question.questions);
			expect(event.parentItemId).toBe(parentItemId);
			return event.itemId;
		});
		return { handle, delivered, ask, publish };
	});

it("keeps duplicate delivery stable while giving replacements separate authority", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const old = yield* fixture();
				const replacement = yield* fixture();
				const first = yield* old.ask;
				expect(yield* old.ask).toBe(first);
				const second = yield* replacement.ask;
				expect(second).not.toBe(first);
				expect(first).not.toBe(nativeId);
				for (const foreign of [first, nativeId])
					expect(
						Exit.isFailure(
							yield* Effect.exit(
								replacement.handle.answerQuestion(foreign, answers),
							),
						),
					).toBe(true);
				yield* replacement.handle.acknowledgeQuestionAnswer?.(first) ??
					Effect.void;
				expect(replacement.delivered).toEqual([]);
				yield* replacement.handle.answerQuestion(second, answers);
				yield* replacement.handle.acknowledgeQuestionAnswer?.(second) ??
					Effect.void;
				expect(replacement.delivered).toEqual([
					`answer:${nativeId}`,
					`ack:${nativeId}`,
				]);
				expect(old.delivered).toEqual([]);
			}),
		),
	);
});

it.each([
	"acknowledged",
	"released",
	"resolved",
] as const)("does not reuse an application request after it is %s", async (mode) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { handle, ask, publish, delivered } = yield* fixture();
				const first = yield* ask;
				if (mode === "acknowledged")
					yield* handle.acknowledgeQuestionAnswer?.(first) ?? Effect.void;
				else {
					const ended = yield* publish(
						mode === "released"
							? {
									_tag: "QuestionCallbackReleased",
									itemId: nativeId,
									reason: "transport_lost",
								}
							: {
									_tag: "UserQuestionResolved",
									itemId: nativeId,
									resolution: "timed-out",
								},
					);
					expect("itemId" in ended && ended.itemId).toBe(first);
				}
				const second = yield* ask;
				expect(second).not.toBe(first);
				const before = delivered.length;
				expect(
					Exit.isFailure(
						yield* Effect.exit(handle.answerQuestion(first, answers)),
					),
				).toBe(true);
				expect(
					Exit.isFailure(
						yield* Effect.exit(handle.cancelQuestion?.(first) ?? Effect.void),
					),
				).toBe(true);
				yield* handle.acknowledgeQuestionAnswer?.(first) ?? Effect.void;
				expect(delivered).toHaveLength(before);
				yield* handle.cancelQuestion?.(second) ?? Effect.void;
				expect(delivered.at(-1)).toBe(`cancel:${nativeId}`);
			}),
		),
	);
});

it("revokes callback authority before asynchronous close completes", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const { handle, ask, delivered } = yield* fixture(
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				);
				const id = yield* ask;
				const closing = yield* Effect.forkChild(handle.close());
				yield* Deferred.await(entered);
				expect(
					Exit.isFailure(
						yield* Effect.exit(handle.answerQuestion(id, answers)),
					),
				).toBe(true);
				yield* handle.acknowledgeQuestionAnswer?.(id) ?? Effect.void;
				expect(delivered).toEqual([]);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(closing);
			}),
		),
	);
});

it.each([
	"legacy-native",
	"prior-acquisition",
] as const)("cannot replay a %s receipt into a replacement callback", async (source) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE messages (session_id TEXT, kind TEXT, content_json TEXT)`;
				yield* sql`CREATE TABLE events (stream_kind TEXT, stream_id TEXT, type TEXT, payload_json TEXT)`;
				yield* sql`CREATE TABLE question_answer_deliveries (session_id TEXT, item_id TEXT)`;
				const previous = yield* fixture();
				const replacement = yield* fixture();
				const previousId =
					source === "legacy-native" ? nativeId : yield* previous.ask;
				const currentId = yield* replacement.ask;
				const sessionId = SessionId.make("session-1");
				yield* sql`INSERT INTO messages VALUES (${sessionId}, 'user_question_answer', ${JSON.stringify({ itemId: previousId, answers })})`;
				yield* sql`INSERT INTO question_answer_deliveries VALUES (${sessionId}, ${previousId})`;
				const receipt = yield* lookupDurableQuestionResolution(
					sql,
					sessionId,
					previousId,
				);
				if (receipt._tag !== "answer") throw new Error("Missing receipt");
				expect(
					yield* lookupDurableQuestionResolution(sql, sessionId, currentId),
				).toEqual({ _tag: "none" });
				yield* settleDurableQuestionResolution(
					sql,
					{
						hasQuestionAttachment: (_sessionId, itemId) =>
							Effect.succeed(itemId === currentId),
						answerQuestion: (_sessionId, itemId, input) =>
							replacement.handle
								.answerQuestion(itemId, input)
								.pipe(
									Effect.mapError(
										() => new AgentSessionNotFoundError({ sessionId }),
									),
								),
						cancelQuestion: (_sessionId, itemId) =>
							(replacement.handle.cancelQuestion?.(itemId) ?? Effect.void).pipe(
								Effect.mapError(
									() => new AgentSessionNotFoundError({ sessionId }),
								),
							),
						acknowledgeQuestionResolution: (_sessionId, itemId) =>
							replacement.handle.acknowledgeQuestionAnswer?.(itemId) ??
							Effect.void,
					},
					sessionId,
					previousId,
					receipt,
				);
				expect(replacement.delivered).toEqual([]);
				expect(
					yield* sql`SELECT 1 FROM question_answer_deliveries`,
				).toHaveLength(0);
				yield* replacement.handle.answerQuestion(currentId, answers);
				expect(replacement.delivered).toEqual([`answer:${nativeId}`]);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

it("binds native plans to an acquisition and keeps their tool results correlated", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const old = yield* fixture();
				const replacement = yield* fixture();
				const plan = {
					_tag: "ToolUse" as const,
					itemId: nativeId,
					tool: "ExitPlanMode",
					input: { plan: "Implement the change" },
				};
				const first = yield* old.publish(plan);
				const next = yield* replacement.publish(plan);
				if (first._tag !== "ToolUse" || next._tag !== "ToolUse")
					throw new Error("Expected plan tool");
				expect(first.itemId).not.toBe(nativeId);
				expect(next.itemId).not.toBe(first.itemId);
				const request = yield* replacement.publish({
					_tag: "PlanApprovalRequested",
					sessionId: SessionId.make("session"),
					toolCallId: nativeId,
					plan: "Implement the change",
				});
				expect(request).toMatchObject({ toolCallId: next.itemId });
				const respond = replacement.handle.respondToPlan;
				if (respond === undefined) throw new Error("Expected plan callback");
				const questionId = yield* replacement.ask;
				expect(
					Exit.isFailure(yield* Effect.exit(respond(questionId, "approved"))),
				).toBe(true);
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							replacement.handle.answerQuestion(next.itemId, answers),
						),
					),
				).toBe(true);
				for (const id of [nativeId, first.itemId])
					expect(
						Exit.isFailure(yield* Effect.exit(respond(id, "approved"))),
					).toBe(true);
				yield* respond(next.itemId, "approved");
				expect(replacement.delivered).toEqual([`plan:${nativeId}:approved`]);
				const result = yield* replacement.publish({
					_tag: "ToolResult",
					itemId: nativeId,
					output: { outcome: "approved" },
					isError: false,
				});
				expect(result).toMatchObject({ itemId: next.itemId });
				expect(
					yield* replacement.publish({
						_tag: "ToolResult",
						itemId: nativeId,
						output: { outcome: "approved" },
						isError: false,
					}),
				).toEqual(result);
				expect(
					Exit.isFailure(yield* Effect.exit(respond(next.itemId, "approved"))),
				).toBe(true);
				const reissued = yield* replacement.publish(plan);
				if (reissued._tag !== "ToolUse")
					throw new Error("Expected reissued plan");
				expect(reissued.itemId).not.toBe(next.itemId);
				yield* replacement.handle.close();
				expect(
					Exit.isFailure(
						yield* Effect.exit(respond(reissued.itemId, "approved")),
					),
				).toBe(true);
			}),
		),
	);
});

it("reuses accepted plan delivery until receipt commit and rejects conflicting decisions", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const current = yield* fixture(
					Effect.void,
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				);
				const plan = yield* current.publish({
					_tag: "ToolUse",
					itemId: nativeId,
					tool: "ExitPlanMode",
					input: {},
				});
				if (
					plan._tag !== "ToolUse" ||
					current.handle.respondToPlan === undefined
				)
					throw new Error("Missing plan");
				const respond = current.handle.respondToPlan;
				const first = yield* respond(plan.itemId, "approved").pipe(
					Effect.forkScoped,
				);
				yield* Deferred.await(started);
				const second = yield* respond(plan.itemId, "approved").pipe(
					Effect.forkScoped,
				);
				expect(
					Exit.isFailure(yield* Effect.exit(respond(plan.itemId, "cancelled"))),
				).toBe(true);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(second);
				yield* respond(plan.itemId, "approved");
				expect(current.delivered).toEqual([`plan:${nativeId}:approved`]);
			}),
		),
	);
});

it("close revokes a hung plan delivery before native close finishes", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const interrupted = yield* Deferred.make<void>();
				const current = yield* fixture(
					Effect.never,
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
					),
				);
				const plan = yield* current.publish({
					_tag: "ToolUse",
					itemId: nativeId,
					tool: "ExitPlanMode",
					input: {},
				});
				if (
					plan._tag !== "ToolUse" ||
					current.handle.respondToPlan === undefined
				)
					throw new Error("Missing plan");
				const delivery = yield* current.handle
					.respondToPlan(plan.itemId, "approved")
					.pipe(Effect.forkScoped);
				yield* Deferred.await(started);
				yield* current.handle.close().pipe(Effect.forkScoped);
				yield* Deferred.await(interrupted);
				expect(Exit.isFailure(yield* Fiber.await(delivery))).toBe(true);
			}),
		).pipe(Effect.timeout("2 seconds")),
	);
});
