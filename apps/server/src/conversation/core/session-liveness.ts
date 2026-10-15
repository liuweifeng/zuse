import type {
	ChatCreationPhase,
	SessionRuntimeObservation,
} from "@zuse/contracts";
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
			session_status: string;
			queue_paused: number;
			turn_id: string | null;
			attempt_ordinal: number | null;
			attempt_id: string | null;
			started_at: string | null;
			turn_status: string | null;
			expires_at: number | null;
			provider_activity_at: number | null;
			blocked: number;
			queued: number;
			starting: number;
		}>`
 SELECT EXISTS(SELECT 1 FROM queued_messages q WHERE q.session_id=s.id AND q.ready=1 AND s.queue_paused=0) AS queued,
 EXISTS(SELECT 1 FROM jobs j WHERE j.session_id=s.id AND j.kind='provider.turn.send'
 AND j.status='running' AND j.lease_owner IS NOT NULL AND j.lease_expires_at > ${new Date(now).toISOString()}
 AND json_valid(j.request_json) AND json_extract(j.request_json,'$.turnId')=t.id
 AND (json_extract(j.request_json,'$.attemptId')=t.active_attempt_id
 OR (json_type(j.request_json,'$.attemptId') IS NULL AND a.ordinal=1))) AS starting,
 s.queue_paused,t.id AS turn_id,a.ordinal AS attempt_ordinal,
 s.status AS session_status,t.active_attempt_id AS attempt_id,COALESCE(a.started_at,t.requested_at) AS started_at,t.status AS turn_status,l.expires_at,l.provider_activity_at,
 EXISTS(SELECT 1 FROM session_inputs i WHERE i.session_id=s.id AND i.status='pending'
 AND json_valid(i.owner_json) AND json_extract(i.owner_json,'$.providerSessionId')=s.provider_reservation_id
 AND (json_extract(i.owner_json,'$.attempt.attemptId') IS NULL OR json_extract(i.owner_json,'$.attempt.attemptId')=t.active_attempt_id)) AS blocked
 FROM sessions s LEFT JOIN session_turns t ON t.session_id=s.id AND t.status IN ('starting','running','finalizing')
 LEFT JOIN session_attempts a ON a.session_id=s.id AND a.id=t.active_attempt_id
 LEFT JOIN session_ingestion_leases l ON l.session_id=s.id AND l.attempt_id=t.active_attempt_id AND l.provider_session_id=s.provider_reservation_id
 WHERE s.id=${sessionId} LIMIT 1`;
		const row = rows[0];

		let preparation: SessionRuntimeObservation["state"] | null = null;
		if (
			row?.queue_paused === 1 &&
			row.turn_status === "starting" &&
			row.attempt_ordinal === 1 &&
			row.expires_at === null
		) {
			const operations = yield* sql<{ phase: ChatCreationPhase }>`
 SELECT phase FROM chat_creation_operations
 WHERE initial_session_id=${sessionId} AND 'turn_' || operation_id=${row.turn_id}
 LIMIT 1`;
			switch (operations[0]?.phase) {
				case "persisted":
				case "creating_workspace":
				case "running_setup":
				case "starting_agent":
					preparation = "starting";
					break;
				case "failed":
				case "cancelling":
				case "cancelled":
					preparation = "idle";
			}
		}
		const startedAt =
			row?.started_at == null ? null : Date.parse(row.started_at);
		const age = now - (row?.provider_activity_at ?? startedAt ?? now);
		const state: SessionRuntimeObservation["state"] =
			preparation ??
			(row?.turn_status === "finalizing"
				? "finalizing"
				: row?.session_status === "error" &&
						(row.expires_at === null || row.expires_at <= now)
					? "idle"
					: row?.blocked === 1 &&
							(row.attempt_id === null ||
								(row.expires_at !== null && row.expires_at > now))
						? "blocked"
						: row?.attempt_id == null
							? row?.queued === 1
								? "starting"
								: "idle"
							: row.expires_at === null || row.expires_at <= now
								? row.expires_at === null &&
									(row.starting === 1 || now - (startedAt ?? now) < 30_000)
									? "starting"
									: "unavailable"
								: age >= PROVIDER_QUIET_MS
									? "stalled"
									: "running");
		return {
			state,
			observedAt: now,
			attemptId: row?.attempt_id ?? null,
			lastProviderActivityAt: row?.provider_activity_at ?? null,
		} satisfies SessionRuntimeObservation;
	});
