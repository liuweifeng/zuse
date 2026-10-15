import type { SessionEvent } from "@zuse/domain/core/events";
import { evolveAll, initialSessionState } from "@zuse/domain/core/state";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { Migration0068AttemptHistory } from "../../src/persistence/migrations/0068_attempt_history.ts";

test("rebuilds legacy and retried attempts without transcripts or cross-session collisions", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE events (sequence INTEGER PRIMARY KEY, stream_id TEXT, stream_kind TEXT, type TEXT, payload_json TEXT)`;
			const events: readonly SessionEvent[] = [
				{ _tag: "TurnStarted", turnId: "shared-turn", startedAt: 10 },
				{
					_tag: "AttemptStarted",
					turnId: "shared-turn",
					attemptId: "shared-retry",
					ordinal: 2,
					reason: "retry",
					startedAt: 20,
					turnOrdinal: 1,
					providerThreadId: null,
					turnRequestedAt: 10,
				},
				{
					_tag: "TurnSettled",
					turnId: "shared-turn",
					outcome: "interrupted",
					settledAt: 30,
				},
			];
			let sequence = 0;
			for (const session of ["one", "two", "deleted"]) {
				if (session !== "deleted")
					yield* sql`INSERT INTO sessions VALUES (${session})`;
				for (const event of events)
					yield* sql`INSERT INTO events VALUES (${++sequence}, ${session}, 'session', ${event._tag}, ${JSON.stringify(event)})`;

				yield* sql`INSERT INTO events VALUES (${++sequence}, ${session}, 'session', 'MessagePersisted', 'not-json')`;
			}
			const expected = [
				...(evolveAll(initialSessionState, events)
					.turns.get("shared-turn")
					?.attempts.values() ?? []),
			];
			for (let pass = 0; pass < 2; pass++) {
				yield* Migration0068AttemptHistory;
				for (const session of ["one", "two"]) {
					const rows = yield* sql<{
						id: string;
						ordinal: number;
						reason: string;
						status: string;
						started_at: string;
						completed_at: string | null;
					}>`SELECT id, ordinal, reason, status, started_at, completed_at FROM session_attempts WHERE session_id = ${session} ORDER BY ordinal`;
					expect(
						rows.map((row) => ({
							id: row.id,
							ordinal: row.ordinal,
							reason: row.reason,
							status: row.status,
							startedAt: Date.parse(row.started_at),
							completedAt:
								row.completed_at === null ? null : Date.parse(row.completed_at),
						})),
					).toEqual(expected);
				}
				expect(
					yield* sql`SELECT id FROM session_attempts WHERE session_id = 'deleted'`,
				).toEqual([]);
			}
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test("continues attempt reconstruction across lifecycle event pages", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE events (sequence INTEGER PRIMARY KEY, stream_id TEXT, stream_kind TEXT, type TEXT, payload_json TEXT)`;
			yield* sql`INSERT INTO sessions VALUES ('many')`;
			for (let ordinal = 1; ordinal <= 502; ordinal++) {
				const event: SessionEvent =
					ordinal === 1
						? { _tag: "TurnStarted", turnId: "many-turn", startedAt: ordinal }
						: {
								_tag: "AttemptStarted",
								turnId: "many-turn",
								attemptId: `retry-${ordinal}`,
								ordinal,
								reason: "retry",
								startedAt: ordinal,
								turnOrdinal: 1,
								providerThreadId: null,
								turnRequestedAt: 1,
							};
				yield* sql`INSERT INTO events VALUES (${ordinal}, 'many', 'session', ${event._tag}, ${JSON.stringify(event)})`;
			}
			yield* Migration0068AttemptHistory;
			expect(
				yield* sql`SELECT status, COUNT(*) AS count FROM session_attempts GROUP BY status ORDER BY status`,
			).toEqual([
				{ status: "running", count: 1 },
				{ status: "superseded", count: 501 },
			]);
			expect(
				yield* sql`SELECT ordinal FROM session_attempts WHERE status = 'running'`,
			).toEqual([{ ordinal: 502 }]);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
