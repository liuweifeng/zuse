import type { SessionRuntimeObservation } from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export const PROVIDER_QUIET_MS = 120_000;
/** An observation describes execution evidence, never the health of the viewing client. */
export const observeSessionRuntime = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	now = Date.now(),
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			attempt_id: string | null;
			requested_at: string | null;
			turn_status: string | null;
			expires_at: number | null;
			provider_activity_at: number | null;
			blocked: number;
			queued: number;
		}>`
 SELECT EXISTS(SELECT 1 FROM queued_messages q WHERE q.session_id=s.id AND q.ready=1 AND s.queue_paused=0) AS queued,
 t.active_attempt_id AS attempt_id,t.requested_at,t.status AS turn_status,l.expires_at,l.provider_activity_at,
 EXISTS(SELECT 1 FROM session_inputs i WHERE i.session_id=s.id AND i.status='pending'
 AND json_valid(i.owner_json) AND json_extract(i.owner_json,'$.providerSessionId')=s.provider_reservation_id
 AND (json_extract(i.owner_json,'$.attempt.attemptId') IS NULL OR json_extract(i.owner_json,'$.attempt.attemptId')=t.active_attempt_id)) AS blocked
 FROM sessions s LEFT JOIN session_turns t ON t.session_id=s.id AND t.status IN ('starting','running','finalizing')
 LEFT JOIN session_ingestion_leases l ON l.session_id=s.id AND l.attempt_id=t.active_attempt_id AND l.provider_session_id=s.provider_reservation_id
 WHERE s.id=${sessionId} LIMIT 1`;
		const row = rows[0];
		const requestedAt =
			row?.requested_at == null ? null : Date.parse(row.requested_at);
		const age = now - (row?.provider_activity_at ?? requestedAt ?? now);
		const state: SessionRuntimeObservation["state"] =
			row?.turn_status === "finalizing"
				? "finalizing"
				: row?.blocked === 1 &&
						(row.attempt_id === null ||
							(row.expires_at !== null && row.expires_at > now))
					? "blocked"
					: row?.attempt_id == null
						? row?.queued === 1
							? "starting"
							: "idle"
						: row.expires_at === null || row.expires_at <= now
							? // Admission marks running before acquiring the response listener.
								// A missing first lease is startup; an expired lease is real loss.
								row.expires_at === null && now - (requestedAt ?? now) < 30_000
								? "starting"
								: "unavailable"
							: age >= PROVIDER_QUIET_MS
								? "stalled"
								: "running";
		return {
			state,
			observedAt: now,
			attemptId: row?.attempt_id ?? null,
			lastProviderActivityAt: row?.provider_activity_at ?? null,
		} satisfies SessionRuntimeObservation;
	});
