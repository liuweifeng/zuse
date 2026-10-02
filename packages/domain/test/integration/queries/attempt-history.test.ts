import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import type { SessionCommand } from "../../../src/core/commands.js";
import { evolveAll, initialSessionState } from "../../../src/core/state.js";
import { makeSessionDomain } from "../../../src/engine/session-domain.js";
import { projectSessionAttempt } from "../../../src/projectors/sql-attempt-projector.js";
import { makeSqlSessionQueries } from "../../../src/queries/sql-session-queries.js";
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
				// Repeated migration/replay must preserve terminal and superseded rows.
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
