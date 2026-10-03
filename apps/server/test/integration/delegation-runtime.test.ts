import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { validateDelegationOrigin } from "../../src/conversation/core/delegation-origin.ts";
import { makeDelegationRuntime } from "../../src/conversation/core/delegation-runtime.ts";

const fixture = Effect.gen(function* () {
	yield* createDomainTestSchema();
	const sql = yield* SqlClient.SqlClient;
	const domain = yield* makeSessionDomain(sql, () =>
		Effect.succeed(crypto.randomUUID()),
	);
	for (const id of ["parent", "child"]) {
		yield* domain.dispatch({
			streamId: id,
			commandId: `create:${id}`,
			command: { ...createSessionCommand, sessionId: id },
		});
		yield* domain.dispatch({
			streamId: id,
			commandId: `start:${id}`,
			command: { _tag: "StartTurn", turnId: `turn:${id}`, startedAt: 2 },
		});
	}
	yield* sql`UPDATE session_turns SET active_attempt_id='attempt:parent' WHERE id='turn:parent'`;
	yield* sql`INSERT INTO session_delegations(child_session_id,child_turn_id,parent_session_id,parent_turn_id,parent_attempt_id,provider_session_id,created_at) VALUES('child','turn:child','parent','turn:parent','attempt:parent','native:parent',2)`;
	return { sql, domain, runtime: makeDelegationRuntime(sql, domain) };
});
const run = <A, E>(
	program: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
	Effect.runPromise(
		Effect.scoped(program).pipe(
			Effect.provide(sqliteLayer({ filename: ":memory:" })),
		),
	);

it("captures child result once across restart and admits one parent completion wake", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, domain, runtime } = yield* fixture;
			yield* domain.dispatch({
				streamId: "child",
				commandId: "answer",
				command: {
					_tag: "PersistMessage",
					messageId: "answer",
					turnId: "turn:child",
					role: "assistant",
					kind: "assistant",
					contentJson: JSON.stringify({
						_tag: "assistant",
						text: "Child finished the task.",
					}),
					parentItemId: null,
					createdAt: 3,
				},
			});
			yield* domain.dispatch({
				streamId: "child",
				commandId: "finish:child",
				command: {
					_tag: "SettleTurn",
					turnId: "turn:child",
					outcome: "completed",
					settledAt: 4,
				},
			});
			yield* runtime.sweep;
			expect(
				(yield* sql`SELECT * FROM messages WHERE id='delegation-result:child'`)
					.length,
			).toBe(1);
			expect(
				(yield* sql`SELECT * FROM session_turns WHERE id='delegation-wake:turn:parent:attempt:parent'`)
					.length,
			).toBe(0);
			yield* domain.dispatch({
				streamId: "parent",
				commandId: "finish:parent",
				command: {
					_tag: "SettleTurn",
					turnId: "turn:parent",
					outcome: "completed",
					settledAt: 5,
				},
			});
			yield* makeDelegationRuntime(sql, domain).sweep;
			yield* makeDelegationRuntime(sql, domain).sweep;
			expect(
				(yield* sql`SELECT * FROM messages WHERE id='delegation-result:child'`)
					.length,
			).toBe(1);
			expect(
				(yield* sql`SELECT * FROM session_turns WHERE id='delegation-wake:turn:parent:attempt:parent'`)
					.length,
			).toBe(1);
			expect(
				(yield* sql<{
					wake_turn_id: string;
				}>`SELECT wake_turn_id FROM session_delegations`)[0]?.wake_turn_id,
			).toBe("delegation-wake:turn:parent:attempt:parent");
			expect(
				(yield* sql<{
					context_text: string;
				}>`SELECT context_text FROM session_context_links`)[0]?.context_text,
			).toContain("Child finished the task.");
		}),
	);
});
it("cancels the exact child turn after parent interruption without publishing a result", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, domain, runtime } = yield* fixture;
			yield* domain.dispatch({
				streamId: "parent",
				commandId: "interrupt",
				command: {
					_tag: "RequestTurnInterrupt",
					expectedTurnId: "turn:parent",
					requestedAt: 3,
				},
			});
			yield* runtime.sweep;
			yield* runtime.sweep;
			expect(
				(yield* sql<{
					phase: string;
				}>`SELECT phase FROM session_turns WHERE id='turn:child'`)[0]?.phase,
			).toBe("interrupt-requested");
			expect(
				(yield* sql<{
					cancelled_at: number;
				}>`SELECT cancelled_at FROM session_delegations`)[0]?.cancelled_at,
			).toBeGreaterThan(0);
			expect((yield* sql`SELECT * FROM session_context_links`).length).toBe(0);
		}),
	);
});

it.each([
	"consumed",
	"invalidated",
	"paused",
] as const)("handles %s child results without duplicate wake", async (mode) => {
	await run(
		Effect.gen(function* () {
			const { sql, domain, runtime } = yield* fixture;
			yield* domain.dispatch({
				streamId: "child",
				commandId: "done-child",
				command: {
					_tag: "SettleTurn",
					turnId: "turn:child",
					outcome: "completed",
					settledAt: 3,
				},
			});
			yield* runtime.sweep;
			if (mode === "consumed")
				yield* sql`UPDATE session_context_links SET first_turn_id='user-followup'`;
			if (mode === "invalidated")
				yield* sql`UPDATE session_context_links SET invalidated_at=4`;
			if (mode === "paused")
				yield* domain.dispatch({
					streamId: "parent",
					commandId: "pause",
					command: { _tag: "SetQueuePaused", paused: true, updatedAt: 4 },
				});
			yield* domain.dispatch({
				streamId: "parent",
				commandId: "done-parent",
				command: {
					_tag: "SettleTurn",
					turnId: "turn:parent",
					outcome: "completed",
					settledAt: 5,
				},
			});
			yield* runtime.sweep;
			expect(
				(yield* sql`SELECT * FROM session_turns WHERE id='delegation-wake:turn:parent:attempt:parent'`)
					.length,
			).toBe(0);
			const rows = yield* sql<{
				wake_turn_id: string | null;
				cancelled_at: number | null;
			}>`SELECT wake_turn_id,cancelled_at FROM session_delegations`;
			if (mode === "consumed")
				expect(rows[0]?.wake_turn_id).toBe("user-followup");
			if (mode === "invalidated")
				expect(rows[0]?.cancelled_at).toBeGreaterThan(0);
			if (mode === "paused") {
				expect(rows[0]?.wake_turn_id).toBeNull();
				yield* domain.dispatch({
					streamId: "parent",
					commandId: "resume",
					command: { _tag: "SetQueuePaused", paused: false, updatedAt: 6 },
				});
				yield* runtime.sweep;
				expect(
					(yield* sql`SELECT * FROM session_turns WHERE id='delegation-wake:turn:parent:attempt:parent'`)
						.length,
				).toBe(1);
			}
		}),
	);
});

it("rejects stale parent delegation inside the creation transaction without orphaned lineage", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, domain } = yield* fixture;
			yield* sql`UPDATE sessions SET provider_reservation_id='native:parent' WHERE id='parent'`;
			yield* sql`UPDATE session_turns SET phase='running' WHERE id='turn:parent'`;
			const origin = {
				parentSessionId: "parent",
				parentTurnId: "turn:parent",
				parentAttemptId: "attempt:parent",
				providerSessionId: "native:parent",
			};
			yield* validateDelegationOrigin(sql, origin, "child", "codex");
			yield* domain.dispatch({
				streamId: "parent",
				commandId: "revoke",
				command: {
					_tag: "RequestTurnInterrupt",
					expectedTurnId: "turn:parent",
					requestedAt: 3,
				},
			});
			const exit = yield* domain
				.dispatchTransactionally(
					{
						streamId: "new-child",
						commandId: "new-child",
						command: {
							...createSessionCommand,
							sessionId: "new-child",
							delegation: { ...origin, childTurnId: "new-child-turn" },
						},
					},
					() => validateDelegationOrigin(sql, origin, "new-child", "codex"),
				)
				.pipe(Effect.exit);
			expect(exit._tag).toBe("Failure");
			expect(
				(yield* sql`SELECT * FROM sessions WHERE id='new-child'`).length,
			).toBe(0);
			expect(
				(yield* sql`SELECT * FROM session_delegations WHERE child_session_id='new-child'`)
					.length,
			).toBe(0);
		}),
	);
});

it.each([
	"siblings",
	"depth",
	"tree",
] as const)("enforces the %s delegation budget", async (mode) => {
	await run(
		Effect.gen(function* () {
			const { sql } = yield* fixture;
			yield* sql`UPDATE sessions SET provider_reservation_id='native:parent' WHERE id='parent'`;
			yield* sql`UPDATE session_turns SET phase='running' WHERE id='turn:parent'`;
			const count = mode === "siblings" ? 8 : mode === "depth" ? 4 : 32;
			for (let index = 0; index < count; index++) {
				const child =
					mode === "depth"
						? index === 0
							? "parent"
							: `ancestor:${index - 1}`
						: `extra:${index}`;
				const parent =
					mode === "depth"
						? `ancestor:${index}`
						: mode === "siblings"
							? "parent"
							: "child";
				yield* sql`INSERT INTO session_delegations(child_session_id,child_turn_id,parent_session_id,parent_turn_id,parent_attempt_id,provider_session_id,created_at) VALUES(${child},'extra-turn',${parent},'turn:parent','attempt:parent','native:parent',2)`;
			}
			const exit = yield* validateDelegationOrigin(
				sql,
				{
					parentSessionId: "parent",
					parentTurnId: "turn:parent",
					parentAttemptId: "attempt:parent",
					providerSessionId: "native:parent",
				},
				"child",
				"codex",
			).pipe(Effect.exit);
			expect(exit._tag).toBe("Failure");
		}),
	);
});

it("wakes a retried parent attempt despite cancelled children from its earlier attempt", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, domain, runtime } = yield* fixture;
			yield* sql`INSERT INTO session_delegations(child_session_id,child_turn_id,parent_session_id,parent_turn_id,parent_attempt_id,provider_session_id,cancelled_at,created_at) VALUES('previous-child','previous-child-turn','parent','turn:parent','previous-attempt','old-native',1,1)`;
			yield* domain.dispatch({
				streamId: "child",
				commandId: "child-done-retry",
				command: {
					_tag: "SettleTurn",
					turnId: "turn:child",
					outcome: "completed",
					settledAt: 3,
				},
			});
			yield* domain.dispatch({
				streamId: "parent",
				commandId: "parent-done-retry",
				command: {
					_tag: "SettleTurn",
					turnId: "turn:parent",
					outcome: "completed",
					settledAt: 4,
				},
			});
			yield* runtime.sweep;
			expect(
				(yield* sql`SELECT * FROM session_turns WHERE id='delegation-wake:turn:parent:attempt:parent'`)
					.length,
			).toBe(1);
			expect(
				(yield* sql<{
					wake_turn_id: string | null;
				}>`SELECT wake_turn_id FROM session_delegations WHERE child_session_id='previous-child'`)[0]
					?.wake_turn_id,
			).toBeNull();
		}),
	);
});
