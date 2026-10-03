import { SessionId } from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { assertSessionInputUnblocked } from "../../src/conversation/core/session-input-admission.ts";
import { Migration0070IngestionLeases } from "../../src/persistence/migrations/0070_ingestion_leases.ts";

it("refuses sends with the current blocking request and releases expired or superseded inputs", async () => {
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
				const sessionId = SessionId.make("session-1");
				yield* sql`UPDATE sessions SET provider_reservation_id='owner' WHERE id=${sessionId}`;
				yield* sql`INSERT INTO session_inputs(session_id,kind,request_id,status,owner_json,updated_sequence) VALUES (${sessionId},'question','q','pending','{"providerSessionId":"old"}',1)`;
				yield* assertSessionInputUnblocked(sql, sessionId);
				yield* sql`UPDATE session_inputs SET owner_json='{"providerSessionId":"owner"}'`;
				const blocked = yield* assertSessionInputUnblocked(sql, sessionId).pipe(
					Effect.result,
				);
				expect(Result.isFailure(blocked)).toBe(true);
				if (Result.isFailure(blocked))
					expect(blocked.failure).toMatchObject({
						_tag: "SessionInputBlockedError",
						requestId: "q",
						kind: "question",
						sessionId,
					});
				// A response lost after accepting the original send still reaches the
				// normal receipt fingerprint check instead of being refused as a new send.
				yield* assertSessionInputUnblocked(sql, sessionId, "create");
				yield* sql`UPDATE session_inputs SET status='expired'`;
				yield* assertSessionInputUnblocked(sql, sessionId);
				expect(yield* sql`SELECT * FROM queued_messages`).toHaveLength(0);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
