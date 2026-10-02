import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Exit, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import type { SessionCommand } from "../../../src/core/commands.js";
import {
	attemptIdFor,
	evolveAll,
	initialSessionState,
} from "../../../src/core/state.js";
import { makeSessionDomain } from "../../../src/engine/session-domain.js";
import { makeSqlSessionQueries } from "../../../src/queries/sql-session-queries.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

test("native execution identity is durable, immutable, and scoped to its exact attempt", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`native-${++sequence}`),
				);
				const dispatch = (command: SessionCommand) =>
					domain.dispatch({
						commandId: crypto.randomUUID(),
						streamId: "session-1",
						command,
					});
				yield* dispatch({ ...createSessionCommand, providerId: "codex" });
				yield* dispatch({ _tag: "StartTurn", turnId: "turn-1", startedAt: 10 });
				const attemptId = attemptIdFor("turn-1", 1);
				const reference = {
					provider: "codex" as const,
					nativeThreadId: "native-thread",
					nativeTurnId: "native-turn",
				};
				const bind = {
					_tag: "BindAttemptProviderTurn" as const,
					turnId: "turn-1",
					attemptId,
					reference,
					boundAt: 11,
				};
				yield* dispatch(bind);
				const version = yield* domain.currentStreamVersion("session-1");
				yield* dispatch(bind);
				expect(yield* domain.currentStreamVersion("session-1")).toBe(version);
				const queries = makeSqlSessionQueries(sql);
				expect(
					yield* queries.attemptProviderTurn("session-1", attemptId),
				).toEqual(reference);
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							dispatch({
								...bind,
								reference: { ...reference, nativeTurnId: "other" },
							}),
						),
					),
				).toBe(true);
				yield* dispatch({
					_tag: "RetryTurn",
					turnId: "turn-1",
					reason: "retry",
					providerInputJson: "{}",
					requestedAt: 20,
				});
				const retryId = attemptIdFor("turn-1", 2);
				expect(Exit.isFailure(yield* Effect.exit(dispatch(bind)))).toBe(true);
				expect(
					Exit.isFailure(
						yield* Effect.exit(dispatch({ ...bind, attemptId: retryId })),
					),
				).toBe(true);
				const retryReference = { ...reference, nativeTurnId: "native-retry" };
				yield* dispatch({
					...bind,
					attemptId: retryId,
					reference: retryReference,
				});
				yield* dispatch({
					_tag: "SettleTurn",
					turnId: "turn-1",
					outcome: "completed",
					settledAt: 30,
				});
				expect(
					Exit.isFailure(
						yield* Effect.exit(dispatch({ ...bind, attemptId: retryId })),
					),
				).toBe(true);
				expect(
					yield* queries.attemptProviderTurn("session-1", attemptId),
				).toEqual(reference);
				expect(
					yield* queries.attemptProviderTurn("session-1", retryId),
				).toEqual(retryReference);
				const records = yield* Stream.runCollect(
					domain
						.events({ streamId: "session-1" })
						.pipe(Stream.take(yield* domain.currentStreamVersion("session-1"))),
				);
				const state = evolveAll(
					initialSessionState,
					records.map((record) => record.event),
				);
				expect([...state.attemptProviderTurns.entries()]).toEqual([
					[attemptId, reference],
					[retryId, retryReference],
				]);
				yield* domain.dispatch({
					commandId: "other-session",
					streamId: "session-2",
					command: {
						...createSessionCommand,
						sessionId: "session-2",
						providerId: "codex",
					},
				});
				expect(
					yield* queries.attemptProviderTurn("session-2", attemptId),
				).toBeNull();
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
