import { layer } from "@zuse/sqlite";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { makeSessionDomain } from "../../../src/engine/session-domain.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

test("nested queue commands cannot deadlock ingestion and every session read", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const waitingForSql = yield* Deferred.make<void>();
				let observeNextTransaction = false;
				const observed = new Proxy(sql, {
					get(target, key, receiver) {
						if (key === "withTransaction")
							return <A, E, R>(work: Effect.Effect<A, E, R>) =>
								Effect.gen(function* () {
									if (observeNextTransaction) {
										observeNextTransaction = false;
										yield* Deferred.succeed(waitingForSql, undefined);
									}
									return yield* target.withTransaction(work);
								});
						return Reflect.get(target, key, receiver);
					},
				});
				let nextId = 0;
				const domain = yield* makeSessionDomain(observed, () =>
					Effect.succeed(`event-${++nextId}`),
				);
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "start",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 1 },
				});
				const entered = yield* Deferred.make<void>();
				const continueQueue = yield* Deferred.make<void>();
				const queue = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(continueQueue);
							return yield* domain.dispatch({
								commandId: "queue",
								streamId: "session-1",
								command: {
									_tag: "EnqueueTurn",
									queueId: "feedback",
									inputJson: JSON.stringify({
										text: "feedback",
										attachments: [],
										fileRefs: [],
										skillRefs: [],
									}),
									position: 0,
									createdAt: 2,
									ready: true,
								},
							});
						}),
					)
					.pipe(Effect.forkScoped);
				yield* Deferred.await(entered);
				observeNextTransaction = true;
				const ingestion = yield* domain
					.dispatch({
						commandId: "ingestion",
						streamId: "session-1",
						command: {
							_tag: "PersistMessage",
							messageId: "native-output",
							turnId: "turn-1",
							role: "assistant",
							kind: "assistant",
							contentJson: JSON.stringify({
								_tag: "assistant",
								text: "native result",
							}),
							parentItemId: null,
							createdAt: 3,
						},
					})
					.pipe(Effect.forkScoped);
				yield* Deferred.await(waitingForSql);
				yield* Deferred.succeed(continueQueue, undefined);
				const result = yield* Effect.raceFirst(
					Fiber.join(queue).pipe(Effect.as("committed")),
					Effect.sleep("200 millis").pipe(Effect.as("deadlocked")),
				);
				// Release the transaction even on the broken implementation so the test can finish.
				yield* Fiber.interrupt(queue);
				yield* Fiber.join(ingestion);
				const sessions =
					yield* sql`SELECT status,queue_paused FROM sessions WHERE id='session-1'`;
				expect(result).toBe("committed");
				expect(sessions).toEqual([{ status: "running", queue_paused: 0 }]);
				expect(
					yield* sql`SELECT id FROM queued_messages WHERE session_id='session-1'`,
				).toEqual([{ id: "feedback" }]);
				expect(
					yield* sql`SELECT id FROM messages WHERE id='native-output'`,
				).toEqual([{ id: "native-output" }]);
			}),
		).pipe(Effect.provide(layer({ filename: ":memory:" }))),
	);
});

test("nested commands do not wait on an event publisher blocked by their transaction", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const publisherWaiting = yield* Deferred.make<void>();
				let observeRead = false;
				const observed = new Proxy(sql, {
					apply(target, thisArg, args) {
						const statement = Reflect.apply(target, thisArg, args);
						const query = Array.isArray(args[0]) ? args[0].join("?") : "";
						if (
							query.includes("AND sequence >") &&
							!query.includes("stream_id =")
						)
							return Effect.suspend(() => {
								if (!observeRead) return statement;
								observeRead = false;
								return Deferred.succeed(publisherWaiting, undefined).pipe(
									Effect.andThen(statement),
								);
							});
						return statement;
					},
				});
				let nextId = 0;
				const domain = yield* makeSessionDomain(observed, () =>
					Effect.succeed(`event-${++nextId}`),
				);
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const entered = yield* Deferred.make<void>();
				const continueQueue = yield* Deferred.make<void>();
				const queue = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(continueQueue);
							return yield* domain.dispatch({
								commandId: "queue",
								streamId: "session-1",
								command: { _tag: "SetQueuePaused", paused: true, updatedAt: 2 },
							});
						}),
					)
					.pipe(Effect.forkScoped);
				yield* Deferred.await(entered);
				observeRead = true;
				const subscription = yield* domain
					.events({ streamId: "session-1" })
					.pipe(Stream.runDrain, Effect.forkScoped);
				yield* Deferred.await(publisherWaiting);
				yield* Deferred.succeed(continueQueue, undefined);
				const result = yield* Effect.raceFirst(
					Fiber.join(queue).pipe(Effect.as("committed")),
					Effect.sleep("200 millis").pipe(Effect.as("deadlocked")),
				);
				yield* Fiber.interrupt(queue);
				yield* Fiber.interrupt(subscription);
				yield* sql`SELECT 1`;
				expect(result).toBe("committed");
			}),
		).pipe(Effect.provide(layer({ filename: ":memory:" }))),
	);
});

test("publishes only committed nested events and delivers the next event after rollback", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let nextId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextId}`),
				);
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const subscribed = yield* Deferred.make<void>();
				const committed = yield* Deferred.make<void>();
				const seen: string[] = [];
				const subscription = yield* domain
					.events({ streamId: "session-1" })
					.pipe(
						Stream.runForEach((record) =>
							Effect.gen(function* () {
								seen.push(record.event._tag);
								if (record.event._tag === "SessionCreated")
									yield* Deferred.succeed(subscribed, undefined);
								if (record.event._tag === "SessionStatusSet")
									yield* Deferred.succeed(committed, undefined);
							}),
						),
						Effect.forkScoped,
					);
				yield* Deferred.await(subscribed);
				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* domain.dispatch({
								commandId: "rolled-back",
								streamId: "session-1",
								command: { _tag: "SetQueuePaused", paused: true, updatedAt: 2 },
							});
							// Give an incorrectly inline publication a chance to reach the subscriber.
							yield* Effect.yieldNow;
							return yield* Effect.fail("rollback");
						}),
					)
					.pipe(Effect.result);
				yield* domain.dispatch({
					commandId: "committed",
					streamId: "session-1",
					command: { _tag: "SetStatus", status: "running", updatedAt: 3 },
				});
				const delivered = yield* Effect.raceFirst(
					Deferred.await(committed).pipe(Effect.as(true)),
					Effect.sleep("200 millis").pipe(Effect.as(false)),
				);
				yield* Fiber.interrupt(subscription);
				expect(delivered).toBe(true);
				expect(seen).toEqual(["SessionCreated", "SessionStatusSet"]);
			}),
		).pipe(Effect.provide(layer({ filename: ":memory:" }))),
	);
});
