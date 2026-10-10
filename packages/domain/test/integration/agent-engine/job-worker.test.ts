import { JobId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Deferred, Effect, Fiber, type Scope } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import {
	type JobLedger,
	makeSqlJobLedger,
} from "../../../src/agent-engine/job-ledger.js";
import {
	type JobExecutor,
	makeJobWorker,
	retryDelayMs,
} from "../../../src/agent-engine/job-worker.js";
import type { PendingJob } from "../../../src/agent-engine/jobs.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

const run = <A, E>(
	program: (
		ledger: JobLedger,
	) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
): Promise<A> =>
	Effect.runPromise(
		Effect.gen(function* () {
			yield* createDomainTestSchema();
			const sql = yield* SqlClient.SqlClient;
			return yield* program(makeSqlJobLedger(sql));
		}).pipe(
			Effect.scoped,
			Effect.provide(sqliteLayer({ filename: ":memory:" })),
		),
	);

const sendJob = (id: string, sessionId: string): PendingJob => ({
	id: JobId.make(id),
	sessionId,
	request: {
		_tag: "provider.turn.send",
		turnId: `turn-${id}`,
		providerInputJson: "{}",
	},
	causationEventId: `event-${id}`,
	correlationId: "correlation-1",
});

describe("JobWorker", () => {
	test("leaves blocked sends unclaimed while stop work runs, then resumes them when ready", async () => {
		await run((ledger) =>
			Effect.gen(function* () {
				let ready = false;
				const executed: string[] = [];
				const worker = yield* makeJobWorker({
					ledger,
					workerId: "test",
					excludedKinds: () => (ready ? [] : ["provider.turn.send"]),
					execute: (job) =>
						Effect.sync(() => {
							executed.push(job.id);
						}),
				});
				const sends = Array.from({ length: 8 }, (_, index) =>
					sendJob(`send-${index}`, `session-${index}`),
				);
				yield* ledger.enqueue([
					...sends,
					{
						...sendJob("stop", "session-0"),
						request: { _tag: "provider.stop", requestedAt: 1 },
					},
				]);
				expect(yield* worker.drain).toEqual([]);
				expect(executed).toEqual(["stop"]);
				const sql = yield* SqlClient.SqlClient;
				const pending = yield* sql<{
					status: string;
					attempt_count: number;
				}>`SELECT status, attempt_count FROM jobs WHERE kind = 'provider.turn.send'`;
				expect(pending).toHaveLength(8);
				expect(
					pending.every(
						(row) => row.status === "pending" && row.attempt_count === 0,
					),
				).toBe(true);
				ready = true;
				expect(yield* worker.drain).toEqual([]);
				expect(executed).toEqual(["stop", ...sends.map((job) => job.id)]);
			}),
		);
	});

	test("reports every failure in a large explicit drain", async () => {
		await run((ledger) =>
			Effect.gen(function* () {
				const worker = yield* makeJobWorker({
					ledger,
					workerId: "test",
					execute: () =>
						Effect.fail({ message: "failed", retry: "never", cause: null }),
				});
				yield* ledger.enqueue(
					Array.from({ length: 300 }, (_, index) =>
						sendJob(`job-${index}`, "session-1"),
					),
				);
				expect(yield* worker.drainSession("session-1")).toHaveLength(300);
			}),
		);
	});

	test("a session drain neither claims another session's parked work nor waits for its running job", async () => {
		await run((ledger) =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const finish = yield* Deferred.make<void>();
				const executed: string[] = [];
				const worker = yield* makeJobWorker({
					workerId: "test",
					ledger,
					execute: (job) =>
						Effect.gen(function* () {
							executed.push(job.id);
							if (job.sessionId === "busy") {
								yield* Deferred.succeed(started, undefined);
								yield* Deferred.await(finish);
							}
							if (job.sessionId === "parked")
								return yield* Effect.fail({
									message: "unrelated failure",
									retry: "on_demand" as const,
									cause: null,
								});
						}),
				});
				yield* ledger.enqueue([sendJob("parked-job", "parked")]);
				yield* worker.drainSession("parked");
				yield* ledger.enqueue([
					sendJob("busy-job", "busy"),
					sendJob("requested-job", "requested"),
				]);
				const busy = yield* Effect.forkScoped(worker.drainSession("busy"));
				yield* Deferred.await(started);
				expect(yield* worker.drainSession("requested")).toEqual([]);
				expect(executed).toEqual(["parked-job", "busy-job", "requested-job"]);
				expect((yield* ledger.get(JobId.make("parked-job")))?.status).toBe(
					"waiting",
				);
				expect((yield* ledger.get(JobId.make("busy-job")))?.status).toBe(
					"running",
				);
				yield* Deferred.succeed(finish, undefined);
				yield* Fiber.join(busy);
			}),
		);
	});

	test("does not execute a job cancelled between its claim and signal registration", async () => {
		await run((ledger) =>
			Effect.gen(function* () {
				let sends = 0;
				const worker = yield* makeJobWorker({
					workerId: "test",
					execute: () =>
						Effect.sync(() => {
							sends += 1;
						}),
					ledger: {
						...ledger,
						claimNext: (input) =>
							Effect.gen(function* () {
								const claimed = yield* ledger.claimNext(input);
								if (claimed !== null)
									yield* ledger.cancelUnsettled({
										sessionId: claimed.sessionId,
										kinds: ["provider.turn.send"],
										reason: "retry",
									});
								return claimed;
							}),
					},
				});
				yield* ledger.enqueue([sendJob("cancelled-at-claim", "session-1")]);
				expect(yield* worker.drain).toEqual([]);
				expect(sends).toBe(0);
				expect(
					(yield* ledger.get(JobId.make("cancelled-at-claim")))?.status,
				).toBe("cancelled");
			}),
		);
	});

	test("renews long-running claims and observes durable cancellation without an in-memory signal", async () => {
		await run((ledger) =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const worker = yield* makeJobWorker({
					workerId: "test",
					leaseMs: 3000,
					ledger,
					execute: () =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
						),
				});
				yield* ledger.enqueue([sendJob("long-running", "session-1")]);
				const draining = yield* Effect.forkScoped(worker.drain);
				yield* Deferred.await(started);
				yield* TestClock.adjust("10 seconds");
				expect(yield* ledger.reclaimExpired).toBe(0);
				expect((yield* ledger.get(JobId.make("long-running")))?.status).toBe(
					"running",
				);
				yield* ledger.cancelUnsettled({
					sessionId: "session-1",
					kinds: ["provider.turn.send"],
					reason: "new attempt",
				});
				yield* TestClock.adjust("1 second");
				expect(yield* Fiber.join(draining)).toEqual([]);
			}).pipe(Effect.provide(TestClock.layer({}))),
		);
	});

	test("drain executes claimable jobs and settles them as succeeded", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				const executed: string[] = [];
				const execute: JobExecutor = (job) =>
					Effect.sync(() => {
						executed.push(job.id);
					});
				const worker = yield* makeJobWorker({
					ledger,
					execute,
					workerId: "test",
				});
				yield* ledger.enqueue([
					sendJob("job-1", "session-1"),
					sendJob("job-2", "session-1"),
					sendJob("job-3", "session-2"),
				]);
				const failures = yield* worker.drain;
				const rows = yield* ledger.listBySession("session-1");
				return {
					executed,
					failures: failures.length,
					statuses: rows.map((row) => row.status),
				};
			}),
		);
		expect(result.executed.sort()).toEqual(["job-1", "job-2", "job-3"]);
		expect(result.failures).toBe(0);
		expect(result.statuses).toEqual(["succeeded", "succeeded"]);
	});

	test("drain returns failures, retries retryable ones, and fails the rest", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				const execute: JobExecutor = (job) =>
					job.sessionId === "session-1"
						? Effect.fail({
								message: "transient",
								retry: "automatic" as const,
								cause: null,
							})
						: Effect.fail({
								message: "permanent",
								retry: "never" as const,
								cause: null,
							});
				const worker = yield* makeJobWorker({
					ledger,
					execute,
					workerId: "test",
				});
				yield* ledger.enqueue([
					sendJob("job-1", "session-1"),
					sendJob("job-2", "session-2"),
				]);
				const failures = yield* worker.drain;
				const retried = yield* ledger.get(JobId.make("job-1"));
				const failed = yield* ledger.get(JobId.make("job-2"));
				return {
					outcomes: failures
						.map((failure) => [failure.job.id, failure.outcome] as const)
						.sort(),
					retried: retried?.status,
					failed: failed?.status,
					failedError: failed?.lastError,
				};
			}),
		);
		expect(result.outcomes).toEqual([
			["job-1", "retry"],
			["job-2", "failed"],
		]);
		expect(result.retried).toBe("pending");
		expect(result.failed).toBe("failed");
		expect(result.failedError).toBe("permanent");
	});

	test("a retryable job stops retrying after the attempt budget", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				let attempts = 0;
				const execute: JobExecutor = () =>
					Effect.sync(() => {
						attempts += 1;
					}).pipe(
						Effect.andThen(
							Effect.fail({
								message: "still broken",
								retry: "automatic" as const,
								cause: null,
							}),
						),
					);
				const worker = yield* makeJobWorker({
					ledger,
					execute,
					workerId: "test",
					maxAttempts: 2,
				});
				yield* ledger.enqueue([sendJob("job-1", "session-1")]);
				yield* worker.drain;
				// Force the retry to become available and drain again.
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE jobs SET available_at = '2000-01-01T00:00:00.000Z'`;
				const failures = yield* worker.drain;
				const job = yield* ledger.get(JobId.make("job-1"));
				return { attempts, outcome: failures[0]?.outcome, status: job?.status };
			}),
		);
		expect(result).toEqual({
			attempts: 2,
			outcome: "failed",
			status: "failed",
		});
	});

	test("drain waits for a job already in flight on another fibre", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				const release = yield* Deferred.make<void>();
				const execute: JobExecutor = () => Deferred.await(release);
				const worker = yield* makeJobWorker({
					ledger,
					execute,
					workerId: "test",
				});
				yield* ledger.enqueue([sendJob("job-1", "session-1")]);
				const first = yield* Effect.forkScoped(worker.drain);
				yield* Effect.sleep("10 millis");
				const secondFiber = yield* Effect.forkScoped(worker.drain);
				yield* Effect.sleep("10 millis");
				const before = yield* ledger.get(JobId.make("job-1"));
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(secondFiber);
				const after = yield* ledger.get(JobId.make("job-1"));
				return { before: before?.status, after: after?.status };
			}),
		);
		expect(result).toEqual({ before: "running", after: "succeeded" });
	});

	test("cancel interrupts a running job whose row was cancelled", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				const execute: JobExecutor = () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
					);
				const worker = yield* makeJobWorker({
					ledger,
					execute,
					workerId: "test",
				});
				yield* ledger.enqueue([sendJob("job-1", "session-1")]);
				const draining = yield* Effect.forkScoped(worker.drain);
				yield* Deferred.await(started);
				yield* ledger.cancelUnsettled({
					sessionId: "session-1",
					kinds: ["provider.turn.send"],
					reason: "interrupted",
				});
				yield* worker.cancel([JobId.make("job-1")]);
				const failures = yield* Fiber.join(draining);
				const job = yield* ledger.get(JobId.make("job-1"));
				return { settled: failures.length, status: job?.status };
			}),
		);
		expect(result).toEqual({ settled: 0, status: "cancelled" });
	});

	test("an on-demand failure parks the job until an explicit drain retries it", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				let attempts = 0;
				const execute: JobExecutor = () =>
					Effect.suspend(() => {
						attempts += 1;
						return attempts === 1
							? Effect.fail({
									message: "provider cannot start",
									retry: "on_demand" as const,
									cause: null,
								})
							: Effect.void;
					});
				const worker = yield* makeJobWorker({
					ledger,
					execute,
					workerId: "test",
				});
				yield* ledger.enqueue([sendJob("job-1", "session-1")]);
				const first = yield* worker.drain;
				const parked = yield* ledger.get(JobId.make("job-1"));
				// Background loops skip waiting jobs even once they are old enough.
				const background = yield* ledger.claimNext({
					workerId: "loop",
					leaseMs: 1000,
				});
				yield* Effect.sleep("5 millis");
				const second = yield* worker.drain;
				const done = yield* ledger.get(JobId.make("job-1"));
				return {
					firstOutcome: first[0]?.outcome,
					parked: parked?.status,
					background,
					secondFailures: second.length,
					done: done?.status,
					attempts,
				};
			}),
		);
		expect(result).toEqual({
			firstOutcome: "waiting",
			parked: "waiting",
			background: null,
			secondFailures: 0,
			done: "succeeded",
			attempts: 2,
		});
	});

	test("retry delay backs off exponentially and caps at 30 seconds", () => {
		expect(retryDelayMs(1)).toBe(100);
		expect(retryDelayMs(2)).toBe(200);
		expect(retryDelayMs(5)).toBe(1_600);
		expect(retryDelayMs(20)).toBe(30_000);
	});
});
