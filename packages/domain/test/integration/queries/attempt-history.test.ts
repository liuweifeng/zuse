import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import type { SessionCommand } from "../../../src/core/commands.js";
import { evolveAll, initialSessionState } from "../../../src/core/state.js";
import { makeSessionDomain } from "../../../src/engine/session-domain.js";
import { projectSessionAttempt } from "../../../src/projectors/sql-attempt-projector.js";
import {
	makeSqlSessionQueries,
	readSessionAttemptHistory,
} from "../../../src/queries/sql-session-queries.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

test("projects and pages complete attempt history consistently with aggregate replay", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`attempt-event-${++sequence}`),
				);
				const commands: readonly SessionCommand[] = [
					createSessionCommand,
					{ _tag: "StartTurn", turnId: "turn-1", startedAt: 10 },
					{
						_tag: "RetryTurn",
						turnId: "turn-1",
						reason: "retry",
						providerInputJson: "{}",
						requestedAt: 20,
					},
					{
						_tag: "RetryTurn",
						turnId: "turn-1",
						reason: "provider_recovery",
						providerInputJson: "{}",
						requestedAt: 30,
					},
					{
						_tag: "SettleTurn",
						turnId: "turn-1",
						outcome: "completed",
						settledAt: 40,
					},
				];
				for (const [index, command] of commands.entries())
					yield* domain.dispatch({
						commandId: `history-${index}`,
						streamId: "session-1",
						command,
					});
				const queries = makeSqlSessionQueries(sql);
				const first = yield* queries.attemptHistory({
					sessionId: "session-1",
					turnId: "turn-1",
					limit: 2,
				});
				expect(first.items.map((item) => item.status)).toEqual([
					"superseded",
					"superseded",
				]);
				expect(first.nextOrdinal).toBe(2);
				const second = yield* queries.attemptHistory({
					sessionId: "session-1",
					turnId: "turn-1",
					afterOrdinal: first.nextOrdinal ?? 0,
					limit: 2,
				});
				expect(second.items.map((item) => item.status)).toEqual(["completed"]);
				expect(second.nextOrdinal).toBeNull();
				const records = yield* Stream.runCollect(
					domain
						.events({ streamId: "session-1" })
						.pipe(Stream.take(yield* domain.currentStreamVersion("session-1"))),
				);
				const state = evolveAll(
					initialSessionState,
					records.map((record) => record.event),
				);
				expect([...first.items, ...second.items]).toEqual([
					...(state.turns.get("turn-1")?.attempts.values() ?? []),
				]);

				for (const record of records) yield* projectSessionAttempt(sql, record);
				expect(
					(yield* queries.attemptHistory({
						sessionId: "session-1",
						turnId: "turn-1",
					})).items,
				).toEqual([...first.items, ...second.items]);
				expect(
					(yield* queries.attemptHistory({
						sessionId: "session-1",
						turnId: "missing",
					})).items,
				).toEqual([]);
				const missing = yield* queries
					.attemptHistory({ sessionId: "missing", turnId: "turn-1" })
					.pipe(Effect.result);
				expect(missing).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "SessionQueryNotFound" },
				});
				yield* domain.dispatch({
					commandId: "history-delete",
					streamId: "session-1",
					command: { _tag: "DeleteSession", deletedAt: 50 },
				});
				expect(yield* sql`SELECT id FROM session_attempts`).toEqual([]);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test("session history pages every turn without duplicates when new work arrives", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let id = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`history-event-${++id}`),
				);
				const dispatch = (command: SessionCommand) =>
					domain.dispatch({
						commandId: `history-command-${++id}`,
						streamId: "session-1",
						command,
					});
				yield* dispatch(createSessionCommand);
				for (let turn = 1; turn <= 3; turn++) {
					const turnId = `turn-${turn}`;
					yield* dispatch({ _tag: "StartTurn", turnId, startedAt: turn * 100 });
					for (let attempt = 2; attempt <= 20; attempt++)
						yield* dispatch({
							_tag: "RetryTurn",
							turnId,
							reason: "retry",
							providerInputJson: "{}",
							requestedAt: turn * 100 + attempt,
						});
					yield* dispatch({
						_tag: "SettleTurn",
						turnId,
						outcome: "completed",
						settledAt: turn * 100 + 50,
					});
				}
				const first = yield* readSessionAttemptHistory(sql, "session-1");
				expect(first.items).toHaveLength(50);
				expect(first.items[0]).toMatchObject({
					turnId: "turn-3",
					ordinal: 20,
					reason: "retry",
					status: "completed",
				});
				expect(first.nextCursor).toEqual({
					turnOrdinal: 1,
					attemptOrdinal: 11,
				});
				yield* dispatch({
					_tag: "StartTurn",
					turnId: "turn-4",
					startedAt: 400,
				});
				const second = yield* readSessionAttemptHistory(
					sql,
					"session-1",
					first.nextCursor ?? undefined,
				);
				expect(second.items).toHaveLength(10);
				expect(second.nextCursor).toBeNull();
				expect(
					new Set([...first.items, ...second.items].map((item) => item.id))
						.size,
				).toBe(60);
				expect(second.items.at(-1)).toMatchObject({
					turnId: "turn-1",
					ordinal: 1,
					reason: "initial",
					status: "superseded",
				});
				expect(
					(yield* readSessionAttemptHistory(sql, "session-1")).items[0],
				).toMatchObject({ turnId: "turn-4", status: "running" });
				yield* dispatch({
					_tag: "SettleTurn",
					turnId: "turn-4",
					outcome: "interrupted",
					settledAt: 410,
				});
				yield* dispatch({
					_tag: "RollbackTurns",
					throughOrdinal: 2,
					messageSequence: 0,
					removedMessageIds: [],
					rolledBackAt: 420,
				});
				const afterRollback = yield* readSessionAttemptHistory(
					sql,
					"session-1",
				);
				expect(
					afterRollback.items
						.filter((row) => row.turnOrdinal > 2)
						.every((row) => row.rolledBack),
				).toBe(true);
				expect(
					afterRollback.items
						.filter((row) => row.turnOrdinal <= 2)
						.every((row) => !row.rolledBack),
				).toBe(true);
				expect(
					yield* readSessionAttemptHistory(sql, "missing").pipe(Effect.result),
				).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "SessionQueryNotFound" },
				});
				expect(
					yield* readSessionAttemptHistory(sql, "session-1", {
						turnOrdinal: 1,
						attemptOrdinal: -1,
					}).pipe(Effect.result),
				).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "SessionQueryDecodeError" },
				});
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
