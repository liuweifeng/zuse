import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { attemptIdFor } from "../core/state.js";
import type { StoredEvent } from "../engine/dispatch.js";

/** Shared by live projection and migration; transcript payloads are unnecessary. */
export const projectSessionAttempt = (
	sql: SqlClient.SqlClient,
	record: Pick<StoredEvent, "streamId" | "sequence" | "event">,
) =>
	Effect.gen(function* () {
		const { event, streamId, sequence } = record;
		if (event._tag === "SessionDeleted") {
			yield* sql`DELETE FROM session_attempts WHERE session_id = ${streamId}`;
			return;
		}
		if (event._tag === "AttemptProviderTurnBound") {
			yield* sql`UPDATE session_attempts SET provider_turn_json = ${JSON.stringify(event.reference)}
				WHERE session_id = ${streamId} AND turn_id = ${event.turnId} AND id = ${event.attemptId} AND provider_turn_json IS NULL`;
			return;
		}
		if (event._tag === "TurnStarted" || event._tag === "AttemptStarted") {
			const initial = event._tag === "TurnStarted";
			const id = initial
				? (event.attemptId ?? attemptIdFor(event.turnId, 1))
				: event.attemptId;
			const ordinal = initial ? 1 : event.ordinal;
			const reason = initial ? "initial" : event.reason;
			const startedAt = new Date(event.startedAt).toISOString();
			if (!initial) {
				const existing =
					yield* sql`SELECT 1 FROM session_attempts WHERE session_id = ${streamId} AND turn_id = ${event.turnId} LIMIT 1`;
				if (existing.length === 0) return;
				yield* sql`
				UPDATE session_attempts SET status = 'superseded', completed_at = ${startedAt}, updated_sequence = ${sequence}
				WHERE session_id = ${streamId} AND turn_id = ${event.turnId}
					AND ordinal < ${ordinal} AND status = 'running' AND updated_sequence < ${sequence}
			`;
			}
			yield* sql`
			INSERT INTO session_attempts
				(session_id, id, turn_id, ordinal, reason, status, started_at, completed_at, started_sequence, updated_sequence)
			VALUES (${streamId}, ${id}, ${event.turnId}, ${ordinal}, ${reason}, 'running', ${startedAt}, NULL, ${sequence}, ${sequence})
			ON CONFLICT(session_id, id) DO NOTHING
		`;
			return;
		}
		if (event._tag === "TurnSettled") {
			const status = event.outcome === "error" ? "failed" : event.outcome;

			yield* sql`
			UPDATE session_attempts SET status = ${status}, completed_at = ${new Date(event.settledAt).toISOString()}, updated_sequence = ${sequence}
			WHERE session_id = ${streamId} AND updated_sequence < ${sequence}
				AND id = (SELECT id FROM session_attempts WHERE session_id = ${streamId} AND turn_id = ${event.turnId}
					AND started_sequence <= ${sequence} ORDER BY ordinal DESC LIMIT 1)
		`;
		}
	});
