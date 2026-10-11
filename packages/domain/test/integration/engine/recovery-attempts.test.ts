import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import type { SessionCommand } from "../../../src/core/commands.js";
import { attemptIdFor } from "../../../src/core/state.js";
import { makeSessionDomain } from "../../../src/engine/session-domain.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

test("recovery durably replaces delivery with read-only work and preserves its source across restart", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`recover-${++sequence}`),
				);
				const dispatch = (command: SessionCommand) =>
					domain.dispatch({
						commandId: crypto.randomUUID(),
						streamId: "session-1",
						command,
					});
				yield* dispatch({ ...createSessionCommand, providerId: "codex" });
				yield* dispatch({ _tag: "StartTurn", turnId: "turn-1", startedAt: 1 });
				const first = attemptIdFor("turn-1", 1);
				const recover = {
					_tag: "RecoverTurn" as const,
					turnId: "turn-1",
					expectedAttemptId: first,
					requestedAt: 3,
				};
				expect(Exit.isFailure(yield* Effect.exit(dispatch(recover)))).toBe(
					true,
				);
				const reference = {
					provider: "codex" as const,
					nativeThreadId: "thread-native",
					nativeTurnId: "turn-native",
				};
				yield* dispatch({
					_tag: "BindAttemptProviderTurn",
					turnId: "turn-1",
					attemptId: first,
					reference,
					boundAt: 2,
				});
				yield* dispatch(recover);
				expect(Exit.isFailure(yield* Effect.exit(dispatch(recover)))).toBe(
					true,
				);
				const second = attemptIdFor("turn-1", 2);
				expect(yield* domain.activeAttempt("session-1")).toEqual({
					turnId: "turn-1",
					attemptId: second,
				});
				const restarted = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`restarted-${++sequence}`),
				);
				yield* restarted.dispatch({
					commandId: "second-recovery",
					streamId: "session-1",
					command: { ...recover, expectedAttemptId: second },
				});
				const jobs = yield* sql<{
					kind: string;
					status: string;
					request_json: string;
				}>`SELECT kind, status, request_json FROM jobs ORDER BY sequence`;
				expect(jobs.map((job) => [job.kind, job.status])).toEqual([
					["provider.turn.recover", "cancelled"],
					["provider.turn.recover", "pending"],
				]);
				expect(JSON.parse(jobs[1]?.request_json ?? "null")).toMatchObject({
					sourceAttemptId: first,
					reference,
					attemptId: attemptIdFor("turn-1", 3),
				});
				yield* restarted.dispatch({
					commandId: "interrupt",
					streamId: "session-1",
					command: { _tag: "RequestTurnInterrupt", requestedAt: 4 },
				});
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							restarted.dispatch({
								commandId: "forbidden",
								streamId: "session-1",
								command: {
									...recover,
									expectedAttemptId: attemptIdFor("turn-1", 3),
								},
							}),
						),
					),
				).toBe(true);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test("uninterrupted ownership is checked before receipt replay and transactional callbacks", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				const dispatch = (command: SessionCommand) =>
					domain.dispatch({
						commandId: crypto.randomUUID(),
						streamId: "session-1",
						command,
					});
				yield* dispatch(createSessionCommand);
				yield* dispatch({ _tag: "StartTurn", turnId: "turn-1", startedAt: 1 });
				const expectedAttempt = {
					turnId: "turn-1",
					attemptId: attemptIdFor("turn-1", 1),
					requireUninterrupted: true,
				};
				const input = {
					commandId: "recovery-write",
					streamId: "session-1",
					expectedAttempt,
					command: {
						_tag: "PersistMessage" as const,
						messageId: "output",
						turnId: "turn-1",
						role: "assistant",
						kind: "assistant",
						contentJson: '{"_tag":"assistant","text":"before"}',
						parentItemId: null,
						createdAt: 2,
					},
				};
				yield* domain.dispatch(input);
				yield* dispatch({ _tag: "RequestTurnInterrupt", requestedAt: 3 });
				let callbacks = 0;
				for (const commandId of ["recovery-write", "new-recovery-write"]) {
					const result = yield* Effect.exit(
						domain.dispatchTransactionally({ ...input, commandId }, () =>
							Effect.sync(() => {
								callbacks++;
							}),
						),
					);
					expect(Exit.isFailure(result)).toBe(true);
				}
				expect(callbacks).toBe(0);
				expect(yield* sql`SELECT 1 FROM messages`).toHaveLength(1);
				// The interrupt worker retains authority to acknowledge and settle cancellation.
				yield* domain.dispatch({
					commandId: "settle-interrupted",
					streamId: "session-1",
					expectedAttempt: {
						turnId: expectedAttempt.turnId,
						attemptId: expectedAttempt.attemptId,
					},
					command: {
						_tag: "SettleTurn",
						turnId: "turn-1",
						outcome: "interrupted",
						settledAt: 4,
					},
				});
				expect(yield* domain.activeAttempt("session-1")).toBeNull();
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test.each([
	false,
	true,
])("Stop cancels delivery after commit (already claimed: %s)", async (claimed) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				const dispatch = (command: SessionCommand) =>
					domain.dispatch({
						commandId: crypto.randomUUID(),
						streamId: "session-1",
						command,
					});
				yield* dispatch(createSessionCommand);
				yield* dispatch({ _tag: "StartTurn", turnId: "turn-1", startedAt: 1 });
				yield* dispatch({
					_tag: "RetryTurn",
					turnId: "turn-1",
					reason: "retry",
					providerInputJson: "{}",
					requestedAt: 2,
				});
				if (claimed)
					yield* domain.jobs.claimNext({ workerId: "sender", leaseMs: 30000 });
				const stop = {
					commandId: "stop",
					streamId: "session-1",
					command: { _tag: "RequestTurnInterrupt" as const, requestedAt: 3 },
				};
				const aborted = yield* Effect.exit(
					domain.dispatchTransactionally(stop, () => Effect.die("rollback")),
				);
				expect(Exit.isFailure(aborted)).toBe(true);
				expect((yield* domain.jobs.listBySession("session-1"))[0]?.status).toBe(
					claimed ? "running" : "pending",
				);
				yield* domain.dispatch(stop);
				const jobs = yield* domain.jobs.listBySession("session-1");
				expect(jobs.map((job) => [job.request._tag, job.status])).toEqual([
					["provider.turn.send", "cancelled"],
					["provider.turn.interrupt", "pending"],
				]);
				expect(
					(yield* domain.jobs.claimNext({ workerId: "next", leaseMs: 30000 }))
						?.request._tag,
				).toBe("provider.turn.interrupt");
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
