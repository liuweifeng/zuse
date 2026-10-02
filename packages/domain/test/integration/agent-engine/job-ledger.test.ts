import { JobId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import {
	type JobLedger,
	makeSqlJobLedger,
} from "../../../src/agent-engine/job-ledger.js";
import type { PendingJob } from "../../../src/agent-engine/jobs.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

const run = <A, E>(
	program: (ledger: JobLedger) => Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
	Effect.runPromise(
		Effect.gen(function* () {
			yield* createDomainTestSchema();
			const sql = yield* SqlClient.SqlClient;
			return yield* program(makeSqlJobLedger(sql));
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

const sendJob = (
	id: string,
	sessionId: string,
	turnId = "turn-1",
): PendingJob => ({
	id: JobId.make(id),
	sessionId,
	request: {
		_tag: "provider.turn.send",
		turnId,
		providerInputJson: "{}",
	},
	causationEventId: `event-${id}`,
	correlationId: "correlation-1",
});

describe("SqlJobLedger", () => {
	test("expired claims cannot renew or settle, and reclaim releases their session lane", async () => {
		await run((ledger) =>
			Effect.gen(function* () {
				const jobId = JobId.make("expired");
				yield* ledger.enqueue([sendJob(jobId, "session-1")]);
				yield* ledger.claimNext({ workerId: "old-claim", leaseMs: 30_000 });
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ${jobId}`;
				expect(
					yield* ledger.renew({
						jobId,
						workerId: "old-claim",
						leaseMs: 30_000,
					}),
				).toBe(false);
				expect(yield* ledger.succeed({ jobId, workerId: "old-claim" })).toBe(
					false,
				);
				expect(yield* ledger.reclaimExpired).toBe(1);
				const reclaimed = yield* ledger.claimNext({
					workerId: "new-claim",
					leaseMs: 30_000,
				});
				expect(reclaimed?.attemptCount).toBe(2);
				expect(reclaimed?.leaseOwner).toBe("new-claim");
				expect(
					yield* ledger.fail({ jobId, workerId: "old-claim", error: "late" }),
				).toBe(false);
				expect(yield* ledger.succeed({ jobId, workerId: "new-claim" })).toBe(
					true,
				);
			}),
		);
	});

	test("enqueue ignores duplicate ids so retried commands enqueue once", async () => {
		const inserted = await run((ledger) =>
			Effect.gen(function* () {
				const first = yield* ledger.enqueue([sendJob("job-1", "session-1")]);
				const second = yield* ledger.enqueue([sendJob("job-1", "session-1")]);
				return [first, second];
			}),
		);
		expect(inserted).toEqual([1, 0]);
	});

	test("claims oldest first and refuses a second job for a session with a running one", async () => {
		const claimed = await run((ledger) =>
			Effect.gen(function* () {
				yield* ledger.enqueue([
					sendJob("job-1", "session-1"),
					sendJob("job-2", "session-1", "turn-2"),
					sendJob("job-3", "session-2"),
				]);
				const first = yield* ledger.claimNext({ workerId: "w", leaseMs: 1000 });
				const second = yield* ledger.claimNext({
					workerId: "w",
					leaseMs: 1000,
				});
				const third = yield* ledger.claimNext({ workerId: "w", leaseMs: 1000 });
				return [first?.id, second?.id, third?.id];
			}),
		);
		expect(claimed).toEqual(["job-1", "job-3", undefined]);
	});

	test("settlement is owner-guarded and unblocks the session lane", async () => {
		const outcome = await run((ledger) =>
			Effect.gen(function* () {
				yield* ledger.enqueue([
					sendJob("job-1", "session-1"),
					sendJob("job-2", "session-1", "turn-2"),
				]);
				const first = yield* ledger.claimNext({
					workerId: "w1",
					leaseMs: 1000,
				});
				const wrongOwner = yield* ledger.succeed({
					jobId: JobId.make("job-1"),
					workerId: "w2",
				});
				const rightOwner = yield* ledger.succeed({
					jobId: JobId.make("job-1"),
					workerId: "w1",
				});
				const next = yield* ledger.claimNext({ workerId: "w1", leaseMs: 1000 });
				return { first: first?.id, wrongOwner, rightOwner, next: next?.id };
			}),
		);
		expect(outcome).toEqual({
			first: "job-1",
			wrongOwner: false,
			rightOwner: true,
			next: "job-2",
		});
	});

	test("retry returns the job to pending with a later availability and keeps the attempt count", async () => {
		const job = await run((ledger) =>
			Effect.gen(function* () {
				yield* ledger.enqueue([sendJob("job-1", "session-1")]);
				yield* ledger.claimNext({ workerId: "w", leaseMs: 1000 });
				yield* ledger.retry({
					jobId: JobId.make("job-1"),
					workerId: "w",
					delayMs: 60_000,
					error: "provider unavailable",
				});
				const notYet = yield* ledger.claimNext({
					workerId: "w",
					leaseMs: 1000,
				});
				const stored = yield* ledger.get(JobId.make("job-1"));
				return { notYet, stored };
			}),
		);
		expect(job.notYet).toBeNull();
		expect(job.stored).toMatchObject({
			status: "pending",
			attemptCount: 1,
			lastError: "provider unavailable",
		});
	});

	test("cancelUnsettled cancels pending and running jobs of the given kinds only", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				yield* ledger.enqueue([
					sendJob("job-1", "session-1"),
					{
						id: JobId.make("job-2"),
						sessionId: "session-1",
						request: { _tag: "provider.stop", requestedAt: 1 },
						causationEventId: "event-2",
						correlationId: "correlation-1",
					},
					sendJob("job-3", "session-2"),
				]);
				yield* ledger.claimNext({ workerId: "w", leaseMs: 1000 });
				const cancelled = yield* ledger.cancelUnsettled({
					sessionId: "session-1",
					kinds: ["provider.turn.send"],
					reason: "interrupted",
				});
				const rows = yield* ledger.listBySession("session-1");
				const other = yield* ledger.listBySession("session-2");
				return {
					cancelled,
					statuses: rows.map((row) => [row.id, row.status]),
					other: other.map((row) => row.status),
				};
			}),
		);
		expect(result.cancelled).toEqual(["job-1"]);
		expect(result.statuses).toEqual([
			["job-1", "cancelled"],
			["job-2", "pending"],
		]);
		expect(result.other).toEqual(["pending"]);
	});

	test("reconcileAfterProcessLoss requeues running and waiting replayable jobs", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				yield* ledger.enqueue([
					sendJob("job-1", "session-1"),
					sendJob("job-2", "session-2"),
				]);
				yield* ledger.claimNext({ workerId: "dead", leaseMs: 1000 });
				const parked = yield* ledger.claimNext({
					workerId: "dead",
					leaseMs: 1000,
				});
				yield* ledger.hold({
					jobId: JobId.make(parked?.id ?? ""),
					workerId: "dead",
					error: "needs a user retry",
				});
				const counts = yield* ledger.reconcileAfterProcessLoss;
				const claimed = yield* ledger.claimNext({
					workerId: "alive",
					leaseMs: 1000,
				});
				return {
					counts,
					claimed: claimed?.id,
					attempts: claimed?.attemptCount,
				};
			}),
		);
		expect(result).toEqual({
			counts: { requeued: 2, cancelled: 0 },
			claimed: "job-1",
			attempts: 2,
		});
	});

	test("reports the next availability and unsettled count", async () => {
		const result = await run((ledger) =>
			Effect.gen(function* () {
				const empty = yield* ledger.nextAvailableAt;
				yield* ledger.enqueue([sendJob("job-1", "session-1")]);
				const next = yield* ledger.nextAvailableAt;
				const count = yield* ledger.unsettledCount;
				return { empty, hasNext: next !== null, count };
			}),
		);
		expect(result).toEqual({ empty: null, hasNext: true, count: 1 });
	});
});
