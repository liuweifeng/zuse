import { attemptIdFor } from "@zuse/domain/core/state";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Recover ownership from the causing event's position, never the latest turn. */
export const Migration0066JobAttemptOwnership = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const jobs = yield* sql<{
		readonly id: string;
		readonly session_id: string;
		readonly turn_id: string;
		readonly causation_event_id: string | null;
	}>`
  SELECT id, session_id, json_extract(request_json, '$.turnId') AS turn_id, causation_event_id
  FROM jobs WHERE kind IN ('provider.turn.send', 'provider.turn.interrupt')
   AND json_extract(request_json, '$.attemptId') IS NULL
 `;
	for (const job of jobs) {
		const attempts = yield* sql<{
			readonly attempt_id: string | null;
			readonly type: string;
		}>`
   SELECT json_extract(a.payload_json, '$.attemptId') AS attempt_id, a.type
   FROM events a JOIN events cause ON cause.event_id = ${job.causation_event_id}
   WHERE a.stream_kind = 'session' AND a.stream_id = ${job.session_id}
    AND cause.stream_kind = 'session' AND cause.stream_id = a.stream_id
    AND a.stream_version <= cause.stream_version
    AND a.type IN ('TurnStarted', 'AttemptStarted')
    AND json_extract(a.payload_json, '$.turnId') = ${job.turn_id}
   ORDER BY a.stream_version DESC LIMIT 1
  `;
		const attempt = attempts[0];
		if (
			attempt === undefined ||
			(attempt.type === "AttemptStarted" && attempt.attempt_id === null)
		) {
			yield* sql`UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
    last_error = 'Cannot recover the owning attempt from this provider job history.',
    completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
    WHERE id = ${job.id} AND status IN ('pending', 'waiting', 'running')`;
			continue;
		}
		const attemptId = attempt.attempt_id ?? attemptIdFor(job.turn_id, 1);
		yield* sql`UPDATE jobs SET request_json = json_set(request_json, '$.attemptId', ${attemptId}) WHERE id = ${job.id}`;
	}
});
