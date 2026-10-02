import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Migration0061Jobs } from "../../src/persistence/migrations/0061_jobs.ts";
import { Migration0064JobAttemptOwnership } from "../../src/persistence/migrations/0064_job_attempt_ownership.ts";

it("binds old jobs to their causal attempt and refuses missing history", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* Migration0061Jobs;
			yield* sql`CREATE TABLE events (event_id TEXT, stream_kind TEXT, stream_id TEXT, stream_version INTEGER, type TEXT, payload_json TEXT)`;
			const events = [
				["start", "TurnStarted", { turnId: "turn-1" }],
				["send-first", "ProviderTurnRequested", { turnId: "turn-1" }],
				[
					"retry",
					"AttemptStarted",
					{ turnId: "turn-1", attemptId: "retry-attempt" },
				],
				["send-retry", "ProviderTurnRequested", { turnId: "turn-1" }],
				["interrupt-retry", "TurnInterruptRequested", { turnId: "turn-1" }],
				[
					"new-attempt",
					"AttemptStarted",
					{ turnId: "turn-1", attemptId: "current-attempt" },
				],
			] as const;
			for (const [version, [id, type, payload]] of events.entries()) {
				yield* sql`INSERT INTO events VALUES (${id}, 'session', 'session-1', ${version}, ${type}, ${JSON.stringify(payload)})`;
			}
			for (const id of [
				"send-first",
				"send-retry",
				"interrupt-retry",
				"missing",
			]) {
				const kind = id.startsWith("interrupt")
					? "provider.turn.interrupt"
					: "provider.turn.send";
				const payload = JSON.stringify({
					_tag: kind,
					turnId: "turn-1",
					providerInputJson: "{}",
				});
				yield* sql`INSERT INTO jobs (id, session_id, kind, request_json, status, available_at, causation_event_id, created_at, updated_at)
    VALUES (${id}, 'session-1', ${kind}, ${payload}, 'pending', 'now', ${id}, 'now', 'now')`;
			}
			yield* Migration0064JobAttemptOwnership;
			const rows =
				yield* sql`SELECT id, status, json_extract(request_json, '$.attemptId') AS attempt FROM jobs ORDER BY sequence`;
			expect(rows).toEqual([
				{
					id: "send-first",
					status: "pending",
					attempt: "attempt:turn:turn-1:ordinal:1",
				},
				{ id: "send-retry", status: "pending", attempt: "retry-attempt" },
				{ id: "interrupt-retry", status: "pending", attempt: "retry-attempt" },
				{ id: "missing", status: "failed", attempt: null },
			]);
			yield* Migration0064JobAttemptOwnership;
			expect(
				yield* sql`SELECT id, status, json_extract(request_json, '$.attemptId') AS attempt FROM jobs ORDER BY sequence`,
			).toEqual(rows);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
