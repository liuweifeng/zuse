import { type SessionId, SessionInputBlockedError } from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { observeSessionRuntime } from "./session-liveness.ts";

/** Refuse ordinary sends at the same live input boundary used by clients and waits. */
export const assertSessionInputUnblocked = (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
	commandId?: string,
) =>
	Effect.gen(function* () {
		// A retry of committed intent must reach normal receipt/fingerprint validation,
		// even when that earlier execution is now awaiting input.
		if (commandId !== undefined) {
			const prior =
				yield* sql`SELECT command_id FROM command_receipts WHERE command_id=${commandId} AND stream_id=${sessionId} LIMIT 1`.pipe(
					Effect.orDie,
				);
			if (prior.length > 0) return;
		}

		const observation = yield* observeSessionRuntime(sql, sessionId).pipe(
			Effect.orDie,
		);
		if (observation.state !== "blocked") return;
		const rows = yield* sql<{
			request_id: string;
			kind: "permission" | "question" | "plan";
		}>`
   SELECT i.request_id,i.kind FROM session_inputs i JOIN sessions s ON s.id=i.session_id
   WHERE i.session_id=${sessionId} AND i.status='pending' AND json_valid(i.owner_json)
   AND json_extract(i.owner_json,'$.providerSessionId')=s.provider_reservation_id
   AND (json_extract(i.owner_json,'$.attempt.attemptId') IS NULL OR json_extract(i.owner_json,'$.attempt.attemptId')=${observation.attemptId})
   ORDER BY i.requested_sequence LIMIT 1`.pipe(Effect.orDie);
		const request = rows[0];
		if (request !== undefined)
			return yield* new SessionInputBlockedError({
				sessionId,
				requestId: request.request_id,
				kind: request.kind,
				message:
					"Answer or dismiss the pending request before sending another message.",
			});
	});
