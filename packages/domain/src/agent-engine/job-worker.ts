import { randomUUID } from "node:crypto";
import type { JobId } from "@zuse/contracts";
import {
	Cause,
	DateTime,
	Deferred,
	Duration,
	Effect,
	type Exit,
	Option,
	PubSub,
	Ref,
	type Scope,
} from "effect";

import type { JobLedger, JobLedgerError } from "./job-ledger.js";
import type { Job, JobKind } from "./jobs.js";

/**
 * Job worker.
 *
 * Claims jobs from the ledger, runs the executor, and settles the row. Jobs of
 * one session run in order because the ledger's claim predicate refuses to
 * claim while that session has a running job; jobs of different sessions run
 * in parallel up to `concurrency`.
 *
 * `drain` runs every job that is claimable now, including jobs parked as
 * `waiting`, and waits for jobs already in flight, then returns the failures
 * settled meanwhile. Commands use `drainSession` to surface only their session’s failures;
 * tests and explicit maintenance can use `drain` without sleeping. Background
 * loops handle automatic retries whose `availableAt` lies in the future and
 * work committed by other processes; they never touch `waiting` jobs.
 */

/**
 * `automatic`: the worker retries with backoff up to the attempt budget.
 * `on_demand`: the job is parked as `waiting` until an explicit drain (a user
 * action) or boot recovery retries it. `never`: the job fails for good.
 */
export type JobRetry = "automatic" | "on_demand" | "never";

export type JobExecutionFailure = {
	readonly message: string;
	readonly retry: JobRetry;
	readonly cause: unknown;
};

export type JobFailure = {
	readonly job: Job;
	readonly failure: JobExecutionFailure;
	readonly outcome: "retry" | "waiting" | "failed";
};

export type JobExecutor = (
	job: Job,
) => Effect.Effect<void, JobExecutionFailure>;

export interface JobWorkerOptions {
	/** Read immediately before claiming; blocked jobs retain their attempt budget. */
	readonly excludedKinds?: () => ReadonlyArray<JobKind>;
	readonly ledger: JobLedger;
	readonly execute: JobExecutor;
	readonly workerId: string;
	readonly concurrency?: number;
	readonly leaseMs?: number;
	readonly maxAttempts?: number;
	readonly pollIntervalMs?: number;
	/**
	 * Background loops leave freshly committed jobs alone for this long so the
	 * command that implied them can drain them and report their outcome.
	 */
	readonly backgroundGraceMs?: number;
	readonly onFailure?: (failure: JobFailure) => Effect.Effect<void>;
}

export interface JobWorker {
	/** Hint that new jobs were committed. Durable rows remain authoritative. */
	readonly notify: Effect.Effect<void>;
	/** Runs claimable jobs to completion and returns failures settled meanwhile. */
	readonly drain: Effect.Effect<ReadonlyArray<JobFailure>, JobLedgerError>;
	readonly drainSession: (
		sessionId: string,
	) => Effect.Effect<ReadonlyArray<JobFailure>, JobLedgerError>;
	/** Forks the background loops into the current scope. */
	readonly start: Effect.Effect<void, never, Scope.Scope>;
	/** Signals in-process cancellation for jobs already cancelled in the ledger. */
	readonly cancel: (jobIds: ReadonlyArray<JobId>) => Effect.Effect<void>;
}

export const DEFAULT_JOB_LEASE_MS = 30_000;
export const DEFAULT_JOB_MAX_ATTEMPTS = 5;
export const DEFAULT_JOB_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_JOB_CONCURRENCY = 4;
export const DEFAULT_JOB_BACKGROUND_GRACE_MS = 250;

export const retryDelayMs = (attemptCount: number): number =>
	Math.min(30_000, 100 * 2 ** Math.max(0, attemptCount - 1));

const describeCause = (cause: Cause.Cause<unknown>): string => {
	const squashed = Cause.squash(cause);
	return squashed instanceof Error ? squashed.message : String(squashed);
};

export const makeJobWorker = Effect.fn("JobWorker.make")(function* (
	options: JobWorkerOptions,
) {
	const {
		ledger,
		execute,
		workerId,
		concurrency = DEFAULT_JOB_CONCURRENCY,
		leaseMs = DEFAULT_JOB_LEASE_MS,
		maxAttempts = DEFAULT_JOB_MAX_ATTEMPTS,
		pollIntervalMs = DEFAULT_JOB_POLL_INTERVAL_MS,
		backgroundGraceMs = DEFAULT_JOB_BACKGROUND_GRACE_MS,
		onFailure = () => Effect.void,
	} = options;
	const wakeHub = yield* PubSub.sliding<void>(1);
	const settleHub = yield* PubSub.sliding<void>(1);
	const inFlight = yield* Ref.make(0);
	const cancellations = new Map<JobId, Deferred.Deferred<void>>();

	type FailureObserver = {
		readonly sessionId: string | undefined;
		readonly failures: JobFailure[];
	};
	const failureObservers = new Set<FailureObserver>();
	const rememberFailure = (failure: JobFailure) =>
		Effect.sync(() => {
			for (const observer of failureObservers) {
				if (
					observer.sessionId === undefined ||
					observer.sessionId === failure.job.sessionId
				)
					observer.failures.push(failure);
			}
		});

	const settleJob = (job: Job, exit: Exit.Exit<void, JobExecutionFailure>) =>
		Effect.gen(function* () {
			const owner = job.leaseOwner;
			if (owner === null) return;
			if (exit._tag === "Success") {
				yield* ledger.succeed({ jobId: job.id, workerId: owner });
				return;
			}
			const failure: JobExecutionFailure = Option.getOrElse(
				Cause.findErrorOption(exit.cause),
				(): JobExecutionFailure => ({
					message: describeCause(exit.cause),
					retry: "never",
					cause: Cause.squash(exit.cause),
				}),
			);
			const outcome: JobFailure["outcome"] =
				failure.retry === "on_demand"
					? "waiting"
					: failure.retry === "automatic" && job.attemptCount < maxAttempts
						? "retry"
						: "failed";
			let settled: boolean;
			if (outcome === "retry") {
				settled = yield* ledger.retry({
					jobId: job.id,
					workerId: owner,
					delayMs: retryDelayMs(job.attemptCount),
					error: failure.message,
				});
			} else if (outcome === "waiting") {
				settled = yield* ledger.hold({
					jobId: job.id,
					workerId: owner,
					error: failure.message,
				});
			} else {
				settled = yield* ledger.fail({
					jobId: job.id,
					workerId: owner,
					error: failure.message,
				});
			}
			if (!settled) return;
			const record: JobFailure = { job, failure, outcome };
			yield* rememberFailure(record);
			yield* onFailure(record);
		});

	/** Claims and runs one job. Returns `false` when nothing was claimable. */
	const release = Ref.update(inFlight, (count) => count - 1).pipe(
		Effect.andThen(PubSub.publish(settleHub, undefined)),
	);
	const runOnce = (claim: {
		readonly minAgeMs: number;
		readonly sessionId?: string;
		readonly includeWaitingBefore: string | null;
	}) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				yield* ledger.reclaimExpired;
				yield* Ref.update(inFlight, (count) => count + 1);
				const owner = `${workerId}:${randomUUID()}`;
				return yield* Effect.gen(function* () {
					const job = yield* ledger.claimNext({
						workerId: owner,
						leaseMs,
						...claim,
						excludedKinds: options.excludedKinds?.(),
					});
					if (job === null) return false;
					const cancellation = yield* Deferred.make<void>();
					cancellations.set(job.id, cancellation);
					const cancelled = Deferred.await(cancellation).pipe(
						Effect.andThen(
							Effect.fail<JobExecutionFailure>({
								message: "Cancelled or claim lost.",
								retry: "never",
								cause: null,
							}),
						),
					);
					const heartbeat = Effect.gen(function* () {
						while (true) {
							yield* Effect.sleep(
								Duration.millis(Math.max(1, Math.min(1000, leaseMs / 3))),
							);
							const renewed = yield* ledger
								.renew({ jobId: job.id, workerId: owner, leaseMs })
								.pipe(Effect.orDie);
							if (!renewed) {
								yield* Deferred.succeed(cancellation, undefined);
								return yield* Effect.never;
							}
						}
					});
					const execution = Effect.gen(function* () {
						// Registration precedes the durable ownership check, closing the claim/cancel gap.
						const owned = yield* ledger
							.renew({ jobId: job.id, workerId: owner, leaseMs })
							.pipe(Effect.orDie);
						if (!owned) return;
						yield* Effect.raceFirst(
							Effect.suspend(() => execute(job)),
							Effect.raceFirst(cancelled, heartbeat),
						);
					});
					return yield* restore(execution).pipe(
						Effect.exit,
						Effect.flatMap((exit) => settleJob(job, exit)),
						Effect.as(true),
						Effect.ensuring(
							Effect.sync(() => {
								if (cancellations.get(job.id) === cancellation)
									cancellations.delete(job.id);
							}),
						),
					);
				}).pipe(Effect.ensuring(release));
			}),
		);

	const makeDrain = (sessionId?: string) =>
		Effect.gen(function* () {
			const observer = yield* Effect.acquireRelease(
				Effect.sync(() => {
					const observer: FailureObserver = { sessionId, failures: [] };
					failureObservers.add(observer);
					return observer;
				}),
				(observer) =>
					Effect.sync(() => {
						failureObservers.delete(observer);
					}),
			);
			// Waiting jobs parked before this drain get one more attempt; a job that
			// parks itself during the drain waits for the next explicit retry.
			const startedAtIso = (yield* DateTime.nowAsDate).toISOString();
			const settled = yield* PubSub.subscribe(settleHub);
			while (true) {
				const worked = yield* runOnce({
					minAgeMs: 0,
					includeWaitingBefore: startedAtIso,
					sessionId,
				});
				if (worked) continue;
				const pending =
					sessionId === undefined
						? (yield* Ref.get(inFlight)) > 0
						: yield* ledger.hasRunning(sessionId);
				if (!pending) break;
				// Another fibre owns a job for now. Its settlement may unblock a
				// session lane, so look again afterwards.
				yield* Effect.raceFirst(
					PubSub.take(settled),
					Effect.sleep(Duration.millis(Math.min(pollIntervalMs, 1000))),
				);
			}
			return observer.failures;
		}).pipe(Effect.scoped);

	const idleDelayMs = Effect.gen(function* () {
		const next = yield* ledger.nextAvailableAt;
		if (next === null) return Math.min(pollIntervalMs, leaseMs);
		const now = yield* DateTime.nowAsDate;
		const untilAvailable = Date.parse(next) + backgroundGraceMs - now.getTime();
		// Blocked pending jobs must not cause four background loops to poll at 25ms.
		const minimumDelay = options.excludedKinds?.().length ? 1_000 : 25;
		return Math.min(pollIntervalMs, Math.max(minimumDelay, untilAvailable));
	});

	const loop = Effect.gen(function* () {
		const wake = yield* PubSub.subscribe(wakeHub);
		while (true) {
			const outcome = yield* runOnce({
				minAgeMs: backgroundGraceMs,
				includeWaitingBefore: null,
			}).pipe(Effect.exit);
			if (outcome._tag === "Success" && outcome.value) {
				yield* Effect.yieldNow;
				continue;
			}
			if (outcome._tag === "Failure") {
				yield* Effect.logWarning("Job worker iteration failed; retrying").pipe(
					Effect.annotateLogs("cause", describeCause(outcome.cause)),
				);
				yield* Effect.sleep(Duration.millis(Math.min(1_000, pollIntervalMs)));
				continue;
			}
			const delay = yield* idleDelayMs.pipe(
				Effect.catch(() => Effect.succeed(pollIntervalMs)),
			);
			yield* Effect.raceFirst(
				PubSub.take(wake),
				Effect.sleep(Duration.millis(delay)),
			);
		}
	}).pipe(Effect.scoped);

	const start: JobWorker["start"] = Effect.forEach(
		Array.from({ length: Math.max(1, concurrency) }),
		() => Effect.forkScoped(loop),
		{ discard: true },
	);

	const cancel: JobWorker["cancel"] = (jobIds) =>
		Effect.forEach(
			jobIds,
			(jobId) => {
				const cancellation = cancellations.get(jobId);
				return cancellation === undefined
					? Effect.void
					: Deferred.succeed(cancellation, undefined).pipe(Effect.asVoid);
			},
			{ discard: true },
		);

	return {
		notify: PubSub.publish(wakeHub, undefined).pipe(Effect.asVoid),
		drain: makeDrain(),
		drainSession: (sessionId) => makeDrain(sessionId),
		start,
		cancel,
	} satisfies JobWorker;
});
