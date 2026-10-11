import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { makeSessionDomain } from "../../../src/engine/session-domain.js";
import { makeSqlSessionQueries } from "../../../src/queries/sql-session-queries.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

test("reports activity through turn admission, settlement and retry without a renderer", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`activity-event-${++sequence}`),
				);
				const queries = makeSqlSessionQueries(sql);
				expect(yield* queries.activeTurnCount).toBe(0);
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "start",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 10 },
				});
				expect(yield* queries.activeTurnCount).toBe(1);
				yield* domain.dispatch({
					commandId: "retry",
					streamId: "session-1",
					command: {
						_tag: "RetryTurn",
						turnId: "turn-1",
						reason: "retry",
						providerInputJson: "{}",
						requestedAt: 20,
					},
				});
				expect(yield* queries.activeTurnCount).toBe(1);
				yield* domain.dispatch({
					commandId: "settle",
					streamId: "session-1",
					command: {
						_tag: "SettleTurn",
						turnId: "turn-1",
						outcome: "error",
						settledAt: 30,
					},
				});
				expect(yield* queries.activeTurnCount).toBe(0);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
