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
				yield* lease.expire;
				expect(
					(yield* observeSessionRuntime(sql, "session-1", now)).state,
				).toBe("unavailable");
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
