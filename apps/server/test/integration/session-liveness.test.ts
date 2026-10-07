import { attemptIdFor } from "@zuse/domain/core/state";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { acquireIngestionLease } from "../../src/conversation/core/ingestion-lease.ts";
import {
	observeSessionRuntime,
	PROVIDER_QUIET_MS,
} from "../../src/conversation/core/session-liveness.ts";
import { Migration0070IngestionLeases } from "../../src/persistence/migrations/0070_ingestion_leases.ts";

it("distinguishes provider silence, pending input, expired ownership and provider activity", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
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
				expect((yield* observeSessionRuntime(sql, "session-1", 1)).state).toBe(
					"idle",
				);
				yield* sql`INSERT INTO queued_messages VALUES('queued','session-1',1,'{}','now','now',0)`;
				expect((yield* observeSessionRuntime(sql, "session-1", 1)).state).toBe(
					"idle",
				);
				yield* sql`UPDATE queued_messages SET ready=1`;
				expect((yield* observeSessionRuntime(sql, "session-1", 1)).state).toBe(
					"starting",
				);
				yield* sql`UPDATE sessions SET queue_paused=1`;
				expect((yield* observeSessionRuntime(sql, "session-1", 1)).state).toBe(
					"idle",
				);
				yield* sql`UPDATE sessions SET queue_paused=0`;
				yield* sql`DELETE FROM queued_messages`;
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "start",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 1 },
				});
				// Delivery publishes running before provider startup and listener acquisition.
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "sending",
					command: { _tag: "SetStatus", status: "running", updatedAt: 2 },
				});
				expect(
					(yield* observeSessionRuntime(sql, "session-1", 2_001)).state,
				).toBe("starting");
				expect(
					(yield* observeSessionRuntime(sql, "session-1", 30_001)).state,
				).toBe("unavailable");
				yield* sql`UPDATE sessions SET provider_reservation_id='owner' WHERE id='session-1'`;
				let now = 2;
				const lease = yield* acquireIngestionLease(
					sql,
					"session-1",
					{
						turnId: "turn-1",
						attemptId: attemptIdFor("turn-1", 1),
						providerSessionId: "owner",
					},
					{ now: () => now, leaseMs: PROVIDER_QUIET_MS * 3 },
				);
				if (lease === null) throw new Error("missing lease");
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("running");
				now = PROVIDER_QUIET_MS + 2;
				yield* lease.renew();
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("stalled");
				yield* sql`INSERT INTO session_inputs(session_id,kind,request_id,status,owner_json,updated_sequence) VALUES ('session-1','question','q','pending','{"providerSessionId":"owner"}',1)`;
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("blocked");
				yield* sql`UPDATE session_inputs SET status='expired'`;
				yield* lease.renew(now);
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("running");
				// A status error cannot conceal evidence of a still-owned response listener.
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "error-with-owner",
					command: { _tag: "SetStatus", status: "error", updatedAt: now },
				});
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("running");
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "running-with-owner",
					command: { _tag: "SetStatus", status: "running", updatedAt: now },
				});
				yield* lease.expire;
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("unavailable");
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

it("keeps startup failure distinct from lost ownership and gives a retry its own startup window", async () => {
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
					commandId: string,
					command: Parameters<typeof domain.dispatch>[0]["command"],
				) => domain.dispatch({ streamId: "session-1", commandId, command });
				yield* dispatch("create", createSessionCommand);
				yield* dispatch("start", {
					_tag: "StartTurn",
					turnId: "turn-1",
					startedAt: 1,
				});
				yield* dispatch("sending", {
					_tag: "SetStatus",
					status: "running",
					updatedAt: 2,
				});
				// Startup failed before acquiring a response listener. Retain the turn for retry.
				yield* dispatch("failed", {
					_tag: "SetStatus",
					status: "error",
					updatedAt: 5_001,
				});
				expect(
					(yield* observeSessionRuntime(sql, "session-1", 120_001)).state,
				).toBe("idle");
				yield* dispatch("retry", {
					_tag: "RetryTurn",
					turnId: "turn-1",
					reason: "retry",
					providerInputJson: "{}",
					requestedAt: 120_001,
				});
				const retry = yield* observeSessionRuntime(sql, "session-1", 120_002);
				expect(retry.attemptId).toBe(attemptIdFor("turn-1", 2));
				expect(retry.state).toBe("starting");
				// Missing ownership remains a real fault after the retry startup window.
				expect(
					(yield* observeSessionRuntime(sql, "session-1", 150_001)).state,
				).toBe("unavailable");
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

it("uses only a live startup job for the current attempt to extend the listener startup window", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
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
					commandId: "start",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 1 },
				});
				const request = JSON.stringify({
					_tag: "provider.turn.send",
					turnId: "turn-1",
					attemptId: attemptIdFor("turn-1", 1),
					providerInputJson: "{}",
					requestedAt: 1,
				});
				const now = 60_001;
				const leaseExpiry = new Date(now + 1_000).toISOString();
				yield* sql`INSERT INTO jobs(id,session_id,kind,request_json,status,available_at,lease_owner,lease_expires_at,created_at,updated_at) VALUES('startup','session-1','provider.turn.send',${request},'running','now','worker',${leaseExpiry},'now','now')`;
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("starting");
				const historicalRequest = JSON.stringify({ turnId: "turn-1" });
				yield* sql`UPDATE jobs SET request_json=${historicalRequest} WHERE id='startup'`;
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("starting");
				yield* sql`UPDATE jobs SET request_json=${request} WHERE id='startup'`;
				for (const change of [
					{ session_id: "other-session" },
					{
						request_json: JSON.stringify({
							turnId: "other-turn",
							attemptId: attemptIdFor("turn-1", 1),
						}),
					},
					{
						request_json: JSON.stringify({
							turnId: "turn-1",
							attemptId: attemptIdFor("turn-1", 2),
						}),
					},
					{ request_json: "invalid-json" },
					{
						request_json: JSON.stringify({ turnId: "turn-1", attemptId: null }),
					},
					{ kind: "provider.stop" },
					{ status: "waiting" },
					{ lease_owner: null },
					{ lease_expires_at: new Date(now).toISOString() },
				]) {
					yield* sql`UPDATE jobs SET ${sql.update(change)} WHERE id='startup'`;
					expect(
						(yield* observeSessionRuntime(sql, "session-1", now)).state,
					).toBe("unavailable");
					yield* sql`UPDATE jobs SET session_id='session-1',request_json=${request},kind='provider.turn.send',status='running',lease_owner='worker',lease_expires_at=${leaseExpiry} WHERE id='startup'`;
				}
				// Historical requests without an attempt can own only the first attempt.
				yield* sql`UPDATE jobs SET request_json=${historicalRequest} WHERE id='startup'`;
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "retry",
					command: {
						_tag: "RetryTurn",
						turnId: "turn-1",
						reason: "retry",
						providerInputJson: "{}",
						requestedAt: 2,
					},
				});
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("unavailable");
				yield* sql`UPDATE jobs SET request_json=${JSON.stringify({ turnId: "turn-1", attemptId: attemptIdFor("turn-1", 2) })} WHERE id='startup'`;
				// Once a response listener existed, job ownership cannot conceal its loss.
				yield* sql`UPDATE sessions SET provider_reservation_id='owner' WHERE id='session-1'`;
				const lease = yield* acquireIngestionLease(
					sql,
					"session-1",
					{
						turnId: "turn-1",
						attemptId: attemptIdFor("turn-1", 2),
						providerSessionId: "owner",
					},
					{ now: () => now, leaseMs: 1_000 },
				);
				if (lease === null) throw new Error("missing lease");
				yield* lease.expire;
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("unavailable");
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
