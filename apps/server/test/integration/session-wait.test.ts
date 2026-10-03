import {
	AgentSessionId,
	AgentTurnId,
	AttemptId,
	CommandId,
} from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import {
	makeSessionWait,
	makeSessionWaitOperations,
} from "../../src/conversation/core/session-wait.ts";

const required = <T>(value: T | null | undefined): T => {
	if (value == null) throw new Error("Expected a pinned execution identity");
	return value;
};

const sessionId = AgentSessionId.make("session-1");
const run = (
	body: (
		sql: SqlClient.SqlClient,
		domain: import("@zuse/domain/engine/session-domain").SessionDomainApi,
	) => Effect.Effect<void, unknown, import("effect").Scope.Scope>,
) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;

				yield* sql`CREATE TABLE session_ingestion_leases (session_id TEXT,attempt_id TEXT,provider_session_id TEXT,expires_at INTEGER,provider_activity_at INTEGER)`;
				let n = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++n}`),
				);
				yield* domain.dispatch({
					commandId: "create",
					streamId: sessionId,
					command: createSessionCommand,
				});
				yield* body(sql, domain);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

test("wait replays settlement between pinning and subscription and preserves exact completed target", () =>
	run((sql, domain) =>
		Effect.gen(function* () {
			yield* domain.dispatch({
				commandId: "start",
				streamId: sessionId,
				command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 1 },
			});
			const wait = makeSessionWait(sql, {
				currentSequence: domain.currentSequence,
				events: (options) =>
					Stream.unwrap(
						Effect.gen(function* () {
							yield* domain.dispatch({
								commandId: "settle",
								streamId: sessionId,
								command: {
									_tag: "SettleTurn",
									turnId: "turn-1",
									outcome: "completed",
									settledAt: 2,
								},
							});
							return domain.events(options);
						}),
					),
			});
			expect(
				yield* wait({ sessionId, target: "done", timeoutMs: 1000 }),
			).toMatchObject({
				outcome: "reached",
				turnId: "turn-1",
				status: "completed",
			});
			yield* domain.dispatch({
				commandId: "next",
				streamId: sessionId,
				command: { _tag: "StartTurn", turnId: "turn-2", startedAt: 3 },
			});
			expect(
				yield* wait({
					sessionId,
					turnId: AgentTurnId.make("turn-1"),
					target: "done",
				}),
			).toMatchObject({ outcome: "reached", turnId: "turn-1" });
			expect(
				yield* wait({
					sessionId,
					turnId: AgentTurnId.make("turn-1"),
					target: "idle",
				}),
			).toMatchObject({ outcome: "superseded" });
		}),
	));

test("timeout and cancelled observations leave execution live; old attempts cannot observe retries", () =>
	run((sql, domain) =>
		Effect.gen(function* () {
			yield* domain.dispatch({
				commandId: "start",
				streamId: sessionId,
				command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 1 },
			});
			const wait = makeSessionWait(sql, domain);
			const timed = yield* wait({ sessionId, target: "done", timeoutMs: 5 });
			expect(timed.outcome).toBe("timeout");
			const fiber = yield* wait({ sessionId, target: "done" }).pipe(
				Effect.forkChild,
			);
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(fiber);
			expect(
				(yield* sql<{
					status: string;
				}>`SELECT status FROM session_turns WHERE id='turn-1'`)[0]?.status,
			).toBe("starting");
			yield* domain.dispatch({
				commandId: "retry",
				streamId: sessionId,
				command: {
					_tag: "RetryTurn",
					turnId: "turn-1",
					reason: "retry",
					providerInputJson: "{}",
					requestedAt: 2,
				},
			});
			expect(
				yield* wait({
					sessionId,
					turnId: AgentTurnId.make("turn-1"),
					attemptId: AttemptId.make(required(timed.attemptId)),
					target: "done",
				}),
			).toMatchObject({ outcome: "superseded" });
			expect(
				(yield* wait({
					sessionId,
					attemptId: AttemptId.make("foreign"),
					target: "done",
				}).pipe(Effect.result))._tag,
			).toBe("Failure");
		}),
	));

test("send-and-wait submission survives observer timeout and retries use one durable turn", () =>
	run((sql, domain) =>
		Effect.gen(function* () {
			const barrier = yield* Deferred.make<void>();
			const admitted = yield* Deferred.make<void>();
			const scope = yield* Effect.scope;
			const ops = makeSessionWaitOperations({
				sql,
				domain,
				scope,
				send: (input) =>
					Effect.gen(function* () {
						yield* Deferred.await(barrier);
						yield* domain.dispatch({
							commandId: input.commandId,
							streamId: sessionId,
							command: {
								_tag: "StartTurn",
								turnId: required(input.turnId),
								startedAt: 1,
							},
						});
						yield* Deferred.succeed(admitted, undefined);
						return { accepted: true, turnId: input.turnId };
					}).pipe(Effect.orDie),
			});
			const input = {
				sessionId,
				commandId: CommandId.make("durable-send"),
				text: "hello",
			};
			const timed = yield* ops.sendMessageAndWait(input, {
				target: "done",
				timeoutMs: 5,
			});
			expect(timed.outcome).toBe("timeout");
			yield* Deferred.succeed(barrier, undefined);
			yield* Deferred.await(admitted);
			yield* domain.dispatch({
				commandId: "settle",
				streamId: sessionId,
				command: {
					_tag: "SettleTurn",
					turnId: required(timed.turnId),
					outcome: "completed",
					settledAt: 2,
				},
			});
			const retried = yield* ops.sendMessageAndWait(input, {
				target: "done",
				timeoutMs: 1000,
			});
			expect(retried).toMatchObject({
				outcome: "reached",
				turnId: timed.turnId,
				attemptId: timed.attemptId,
			});
			expect((yield* sql`SELECT id FROM session_turns`).length).toBe(1);
		}),
	));

test("blocked waits require live ownership evidence", () =>
	run((sql, domain) =>
		Effect.gen(function* () {
			yield* domain.dispatch({
				commandId: "start",
				streamId: sessionId,
				command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 1 },
			});
			const wait = makeSessionWait(sql, domain);
			const timed = yield* wait({ sessionId, target: "blocked", timeoutMs: 5 });
			yield* sql`UPDATE sessions SET provider_reservation_id='owner' WHERE id=${sessionId}`;
			yield* sql`INSERT INTO session_inputs (session_id,kind,request_id,status,updated_sequence,owner_json) VALUES(${sessionId},'question','q','pending',1,${JSON.stringify({ providerSessionId: "stale", attempt: { attemptId: timed.attemptId } })})`;
			yield* sql`INSERT INTO session_ingestion_leases VALUES(${sessionId},${timed.attemptId},'owner',${Date.now() + 10000},${Date.now()})`;
			expect(
				(yield* wait({ sessionId, target: "blocked", timeoutMs: 5 })).outcome,
			).toBe("timeout");
			yield* sql`UPDATE session_inputs SET owner_json=${JSON.stringify({ providerSessionId: "owner", attempt: { attemptId: timed.attemptId } })}`;
			expect(yield* wait({ sessionId, target: "blocked" })).toMatchObject({
				outcome: "reached",
				attemptId: timed.attemptId,
			});
		}),
	));

test("cancelling send-and-wait leaves its admitted submission owned by the service", () =>
	run((sql, domain) =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const finished = yield* Deferred.make<void>();
			const scope = yield* Effect.scope;
			const ops = makeSessionWaitOperations({
				sql,
				domain,
				scope,
				send: (input) =>
					Effect.gen(function* () {
						yield* Deferred.succeed(entered, undefined);
						yield* Deferred.await(release);
						yield* domain.dispatch({
							commandId: input.commandId,
							streamId: sessionId,
							command: {
								_tag: "StartTurn",
								turnId: required(input.turnId),
								startedAt: 1,
							},
						});
						yield* Deferred.succeed(finished, undefined);
						return { accepted: true, turnId: input.turnId };
					}).pipe(Effect.orDie),
			});
			const observer = yield* ops
				.sendMessageAndWait(
					{
						sessionId,
						commandId: CommandId.make("cancelled-observer"),
						text: "hello",
					},
					{ target: "done" },
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(observer);
			yield* Deferred.succeed(release, undefined);
			yield* Deferred.await(finished);
			expect(
				(yield* sql<{ status: string }>`SELECT status FROM session_turns`)[0]
					?.status,
			).toBe("starting");
		}),
	));

test("session-scoped pending input prevents idle even before the first turn", () =>
	run((sql, domain) =>
		Effect.gen(function* () {
			yield* sql`UPDATE sessions SET provider_reservation_id='owner' WHERE id=${sessionId}`;
			yield* sql`INSERT INTO session_inputs (session_id,kind,request_id,status,updated_sequence,owner_json) VALUES(${sessionId},'question','session-q','pending',1,${JSON.stringify({ providerSessionId: "owner", attempt: null })})`;
			const wait = makeSessionWait(sql, domain);
			expect(yield* wait({ sessionId, target: "blocked" })).toMatchObject({
				outcome: "reached",
				status: "blocked",
				turnId: null,
				attemptId: null,
			});
			expect(yield* wait({ sessionId, target: "idle" })).toMatchObject({
				outcome: "no-turn",
				status: "blocked",
			});
		}),
	));

test("idle wait cannot claim a ready queued execution is idle", () =>
	run((sql, domain) =>
		Effect.gen(function* () {
			yield* sql`INSERT INTO queued_messages VALUES('queued',${sessionId},1,'{}','now','now',1)`;
			const wait = makeSessionWait(sql, domain);
			expect(yield* wait({ sessionId, target: "idle" })).toMatchObject({
				outcome: "no-turn",
				status: "starting",
			});
			yield* domain.dispatch({
				commandId: "start",
				streamId: sessionId,
				command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 1 },
			});
			yield* domain.dispatch({
				commandId: "settle",
				streamId: sessionId,
				command: {
					_tag: "SettleTurn",
					turnId: "turn-1",
					outcome: "completed",
					settledAt: 2,
				},
			});
			expect(yield* wait({ sessionId, target: "idle" })).toMatchObject({
				outcome: "terminal",
				status: "completed",
			});
		}),
	));
