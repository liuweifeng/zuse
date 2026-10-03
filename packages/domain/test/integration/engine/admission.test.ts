import { JobId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Deferred, Effect, Fiber, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { makeSqlAdmission } from "../../../src/engine/admission.js";
import { makeSessionDomain } from "../../../src/engine/session-domain.js";
import { makeSqlSessionQueries } from "../../../src/queries/sql-session-queries.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

const run = <A, E>(
	program: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
	Effect.runPromise(
		Effect.scoped(program).pipe(
			Effect.provide(sqliteLayer({ filename: ":memory:" })),
		),
	);
const setup = Effect.gen(function* () {
	yield* createDomainTestSchema();
	const sql = yield* SqlClient.SqlClient;
	let next = 0;
	const domain = yield* makeSessionDomain(sql, () =>
		Effect.succeed(`event-${++next}`),
	);
	yield* domain.dispatch({
		commandId: "create",
		streamId: "session-1",
		command: createSessionCommand,
	});
	return { sql, domain, queries: makeSqlSessionQueries(sql) };
});
const start = {
	commandId: "start",
	streamId: "session-1",
	command: { _tag: "StartTurn" as const, turnId: "turn-1", startedAt: 1 },
};

test("idle shutdown waits for an admitted transaction and observes its committed active turn", async () => {
	await run(
		Effect.gen(function* () {
			const { domain, queries } = yield* setup;
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const command = yield* domain
				.dispatchTransactionally(start, () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(entered, undefined);
						yield* Deferred.await(release);
					}),
				)
				.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			const shutdown = yield* domain.admission
				.closeIf(
					queries.activeTurnCount.pipe(Effect.map((count) => count === 0)),
				)
				.pipe(Effect.forkScoped);
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(command);
			expect(yield* Fiber.join(shutdown)).toBe(false);
			expect(yield* queries.activeTurnCount).toBe(1);
		}),
	);
});

test("a shutdown decision fences a concurrent new turn before any durable events are written", async () => {
	await run(
		Effect.gen(function* () {
			const { domain, queries } = yield* setup;
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const shutdown = yield* domain.admission
				.closeIf(
					Effect.gen(function* () {
						yield* Deferred.succeed(entered, undefined);
						yield* Deferred.await(release);
						return (yield* queries.activeTurnCount) === 0;
					}),
				)
				.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			const command = yield* domain
				.dispatch(start)
				.pipe(Effect.result, Effect.forkScoped);
			yield* Deferred.succeed(release, undefined);
			expect(yield* Fiber.join(shutdown)).toBe(true);
			const result = yield* Fiber.join(command);
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "AdmissionClosed" },
			});
			expect(yield* queries.activeTurnCount).toBe(0);
			expect(yield* domain.currentStreamVersion("session-1")).toBe(1);
		}),
	);
});

test("closed admission rejects enqueues and does not claim existing jobs", async () => {
	await run(
		Effect.gen(function* () {
			const { domain } = yield* setup;
			const job = {
				id: JobId.make("job-1"),
				sessionId: "session-1",
				request: {
					_tag: "provider.turn.send" as const,
					turnId: "turn-1",
					providerInputJson: "{}",
				},
				causationEventId: "event",
				correlationId: "correlation",
			};
			yield* domain.jobs.enqueue([job]);
			// The caller supplies the shutdown policy; this test isolates the closed gate.
			expect(yield* domain.admission.closeIf(Effect.succeed(true))).toBe(true);
			expect(
				yield* domain.jobs.claimNext({ workerId: "worker", leaseMs: 1000 }),
			).toBeNull();
			expect(
				yield* domain.jobs
					.enqueue([{ ...job, id: JobId.make("job-2") }])
					.pipe(Effect.result),
			).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "AdmissionClosed" },
			});
			expect((yield* domain.jobs.get(job.id))?.status).toBe("pending");
			expect(yield* domain.jobs.get(JobId.make("job-2"))).toBeNull();
		}),
	);
});

test("failed or cancelled idle checks leave admission open; new owners start open", async () => {
	await run(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const gate = makeSqlAdmission(sql);
			expect(yield* gate.closeIf(Effect.succeed(false))).toBe(false);
			yield* gate.closeIf(Effect.fail("read-failed")).pipe(Effect.result);
			expect(yield* gate.run(Effect.succeed("open"))).toBe("open");
			const entered = yield* Deferred.make<void>();
			const pending = yield* gate
				.closeIf(
					Effect.gen(function* () {
						yield* Deferred.succeed(entered, undefined);
						return yield* Effect.never;
					}),
				)
				.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(pending);
			expect(yield* gate.run(Effect.succeed("open"))).toBe("open");
			expect(yield* gate.closeIf(Effect.succeed(true))).toBe(true);
			expect(yield* gate.closeIf(Effect.die("must not recheck"))).toBe(true);
			expect(
				yield* makeSqlAdmission(sql).run(Effect.succeed("new-owner")),
			).toBe("new-owner");
		}),
	);
});

test("unfinished file restore fences execution across sessions until recovery completes", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, domain } = yield* setup;
			yield* sql`INSERT INTO session_checkpoint_restores(id,session_id,project_id,cwd,target_id,expected_id,status,created_at) VALUES ('restore','different-session','different-project','/checkout','target','expected','prepared',1)`;
			expect(yield* domain.dispatch(start).pipe(Effect.result)).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "AdmissionClosed" },
			});
			expect(yield* domain.currentStreamVersion("session-1")).toBe(1);
			// Administrative and recovery commands remain available while execution is fenced.
			yield* domain.dispatch({
				commandId: "pause",
				streamId: "session-1",
				command: { _tag: "SetQueuePaused", paused: true, updatedAt: 2 },
			});
			yield* sql`UPDATE session_checkpoint_restores SET status='completed',completed_at=3 WHERE id='restore'`;
			yield* domain.dispatch(start);
			expect(yield* makeSqlSessionQueries(sql).activeTurnCount).toBe(1);
		}),
	);
});
