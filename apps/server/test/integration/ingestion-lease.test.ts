import { attemptIdFor } from "@zuse/domain/core/state";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { acquireIngestionLease } from "../../src/conversation/core/ingestion-lease.ts";
import { sweepIngestionLeases } from "../../src/conversation/core/ingestion-sweeper.ts";
import { Migration0070IngestionLeases } from "../../src/persistence/migrations/0070_ingestion_leases.ts";

test("ingestion leases separate heartbeat from activity and fence expired or replaced owners", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				yield* Migration0070IngestionLeases;
				yield* Migration0070IngestionLeases;
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "create",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "turn",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 1 },
				});
				yield* sql`UPDATE sessions SET provider_reservation_id = 'provider-1' WHERE id = 'session-1'`;
				const identity = {
					turnId: "turn-1",
					attemptId: attemptIdFor("turn-1", 1),
					providerSessionId: "provider-1",
				};
				let now = 100;
				const options = { now: () => now, leaseMs: 30 };
				const lease = yield* acquireIngestionLease(
					sql,
					"session-1",
					identity,
					options,
				);
				if (lease === null) throw new Error("Lease missing");
				expect(
					yield* acquireIngestionLease(sql, "session-1", identity, options),
				).toBeNull();
				now = 110;
				expect(yield* lease.renew()).toBe(true);
				let rows = yield* sql<{
					heartbeat_at: number;
					provider_activity_at: number | null;
				}>`SELECT heartbeat_at, provider_activity_at FROM session_ingestion_leases`;
				expect(rows[0]).toEqual({
					heartbeat_at: 110,
					provider_activity_at: null,
				});
				now = 120;
				expect(yield* lease.renew(115)).toBe(true);
				rows = yield* sql<{
					heartbeat_at: number;
					provider_activity_at: number | null;
				}>`SELECT heartbeat_at, provider_activity_at FROM session_ingestion_leases`;
				expect(rows[0]).toEqual({
					heartbeat_at: 120,
					provider_activity_at: 115,
				});
				now = 150;
				expect(yield* lease.renew()).toBe(false);
				const replacement = yield* acquireIngestionLease(
					sql,
					"session-1",
					identity,
					options,
				);
				if (replacement === null) throw new Error("Replacement lease missing");
				yield* lease.expire;
				yield* lease.release;
				expect(yield* replacement.renew()).toBe(true);
				yield* sql`UPDATE sessions SET provider_reservation_id = 'provider-2' WHERE id = 'session-1'`;
				expect(yield* replacement.renew()).toBe(false);
				expect(
					yield* acquireIngestionLease(sql, "session-1", identity, options),
				).toBeNull();
				const next = yield* acquireIngestionLease(
					sql,
					"session-1",
					{ ...identity, providerSessionId: "provider-2" },
					options,
				);
				if (next === null) throw new Error("New residency lease missing");
				yield* replacement.release;
				expect(yield* next.renew()).toBe(true);
				yield* next.expire;
				expect(yield* next.renew()).toBe(false);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test.each([
	"unknown",
	"native",
	"interrupted",
	"replaced-during-sweep",
] as const)("expiry handles %s execution without resending or harming a new owner", async (mode) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				yield* Migration0070IngestionLeases;
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				const dispatch = (
					command: Parameters<typeof domain.dispatch>[0]["command"],
				) =>
					domain.dispatch({
						streamId: "session-1",
						commandId: crypto.randomUUID(),
						command,
					});
				yield* dispatch({ ...createSessionCommand, providerId: "codex" });
				yield* dispatch({ _tag: "StartTurn", turnId: "turn-1", startedAt: 1 });
				const identity = {
					turnId: "turn-1",
					attemptId: attemptIdFor("turn-1", 1),
					providerSessionId: "provider-1",
				};
				yield* dispatch({
					_tag: "ReserveProviderSession",
					ownerAttempt: identity,
					providerId: "codex",
					providerSessionId: identity.providerSessionId,
					reservedAt: 2,
				});
				if (mode === "native")
					yield* dispatch({
						_tag: "BindAttemptProviderTurn",
						...identity,
						reference: {
							provider: "codex",
							nativeThreadId: "native-thread",
							nativeTurnId: "native-turn",
						},
						boundAt: 3,
					});
				if (mode === "interrupted")
					yield* dispatch({ _tag: "RequestTurnInterrupt", requestedAt: 4 });
				let now = 100;
				const lease = yield* acquireIngestionLease(sql, "session-1", identity, {
					now: () => now,
					leaseMs: 30,
				});
				expect(lease).not.toBeNull();
				now = 130;
				const sweepDomain: import("@zuse/domain/engine/session-domain").SessionDomainApi =
					mode !== "replaced-during-sweep"
						? domain
						: {
								...domain,
								dispatchTransactionally: (input, onCommitted) =>
									Effect.gen(function* () {
										expect(
											yield* acquireIngestionLease(sql, "session-1", identity, {
												now: () => now,
												leaseMs: 30,
											}),
										).not.toBeNull();
										return yield* domain.dispatchTransactionally(
											input,
											onCommitted,
										);
									}),
							};
				yield* sweepIngestionLeases(sql, sweepDomain, now);
				const active = yield* domain.activeAttempt("session-1");
				const jobs = yield* domain.jobs.listBySession("session-1");
				expect(
					jobs.some((job) => job.request._tag === "provider.turn.send"),
				).toBe(false);
				if (mode === "native") {
					expect(active?.attemptId).toBe(attemptIdFor("turn-1", 2));
					expect(
						jobs.some((job) => job.request._tag === "provider.turn.recover"),
					).toBe(true);
				} else if (mode === "replaced-during-sweep") {
					expect(active?.attemptId).toBe(identity.attemptId);
					expect(jobs).toHaveLength(0);
					expect(yield* sql`SELECT 1 FROM messages`).toHaveLength(0);
					expect(
						yield* sql`SELECT 1 FROM session_ingestion_leases`,
					).toHaveLength(1);
				} else {
					expect(active).toBeNull();
					const turns = yield* sql<{
						status: string;
					}>`SELECT status FROM session_turns`;
					expect(turns[0]?.status).toBe(
						mode === "interrupted" ? "interrupted" : "failed",
					);
				}
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test.each([
	"blocked",
	"failed",
] as const)("a %s session does not prevent other expired leases from settling", async (mode) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				yield* Migration0070IngestionLeases;
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				for (const sessionId of ["blocked-session", "healthy-session"]) {
					const dispatch = (
						command: Parameters<typeof domain.dispatch>[0]["command"],
					) =>
						domain.dispatch({
							streamId: sessionId,
							commandId: crypto.randomUUID(),
							command,
						});
					yield* dispatch({
						...createSessionCommand,
						sessionId,
						chatId: `${sessionId}-chat`,
						providerId: "codex",
					});
					yield* dispatch({
						_tag: "StartTurn",
						turnId: `${sessionId}-turn`,
						startedAt: 1,
					});
					const identity = {
						turnId: `${sessionId}-turn`,
						attemptId: attemptIdFor(`${sessionId}-turn`, 1),
						providerSessionId: `${sessionId}-provider`,
					};
					yield* dispatch({
						_tag: "ReserveProviderSession",
						ownerAttempt: identity,
						providerId: "codex",
						providerSessionId: identity.providerSessionId,
						reservedAt: 2,
					});
					yield* acquireIngestionLease(sql, sessionId, identity, {
						now: () => 100,
						leaseMs: 30,
					});
				}
				const isolatedDomain: typeof domain = {
					...domain,
					dispatchTransactionally: (input, committed) =>
						input.streamId === "blocked-session"
							? mode === "blocked"
								? Effect.never
								: Effect.die("injected session dispatch failure")
							: domain.dispatchTransactionally(input, committed),
				};
				const sweep = yield* Effect.forkChild(
					sweepIngestionLeases(sql, isolatedDomain, 130),
				);
				yield* TestClock.adjust("6 seconds");
				yield* Fiber.join(sweep);
				expect(yield* domain.activeAttempt("healthy-session")).toBeNull();
				expect(yield* domain.activeAttempt("blocked-session")).not.toBeNull();
				expect(
					yield* sql`SELECT 1 FROM session_ingestion_leases WHERE session_id = 'blocked-session'`,
				).toHaveLength(1);
				expect(
					yield* sql`SELECT 1 FROM jobs WHERE kind = 'provider.turn.send'`,
				).toHaveLength(0);
				// A later pass recovers the retained lease without resending input.
				yield* sweepIngestionLeases(sql, domain, 130);
				expect(yield* domain.activeAttempt("blocked-session")).toBeNull();
				expect(yield* sql`SELECT 1 FROM session_ingestion_leases`).toHaveLength(
					0,
				);
				expect(
					yield* sql`SELECT 1 FROM jobs WHERE kind = 'provider.turn.send'`,
				).toHaveLength(0);
			}),
		).pipe(
			Effect.provide(sqliteLayer({ filename: ":memory:" })),
			Effect.provide(TestClock.layer()),
		),
	);
});
