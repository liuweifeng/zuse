import { JobId } from "@zuse/contracts";
import { DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
	isReplayableJobKind,
	type Job,
	type JobKind,
	JobRequest,
	type JobStatus,
	type PendingJob,
	REPLAYABLE_JOB_KINDS,
} from "./jobs.js";

/**
 * SQL-backed job ledger.
 *
 * Every mutation is a single statement guarded by the row's current status
 * (and lease owner for settlement), so two workers or two processes sharing
 * one database cannot both own a job. `enqueue` is designed to run inside the
 * caller's command transaction; it never notifies. Notification is the
 * caller's post-commit responsibility.
 */

import type { AdmissionClosed } from "../engine/admission.js";

export type JobLedgerError = SqlError | JobRowDecodeError | AdmissionClosed;

export class JobRowDecodeError extends Schema.TaggedErrorClass<JobRowDecodeError>()(
	"JobRowDecodeError",
	{
		jobId: Schema.String,
		reason: Schema.String,
	},
) {}

type JobRow = {
	readonly sequence: number;
	readonly id: string;
	readonly session_id: string;
	readonly kind: string;
	readonly request_json: string;
	readonly status: JobStatus;
	readonly attempt_count: number;
	readonly available_at: string;
	readonly lease_owner: string | null;
	readonly lease_expires_at: string | null;
	readonly causation_event_id: string | null;
	readonly correlation_id: string | null;
	readonly last_error: string | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly completed_at: string | null;
};

const JOB_COLUMNS = `sequence, id, session_id, kind, request_json, status,
	attempt_count, available_at, lease_owner, lease_expires_at,
	causation_event_id, correlation_id, last_error, created_at, updated_at,
	completed_at`;

const decodeRequest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(JobRequest),
);

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(JobRequest));

const decodeRow = (row: JobRow): Effect.Effect<Job, JobRowDecodeError> =>
	decodeRequest(row.request_json).pipe(
		Effect.mapError(
			(cause) =>
				new JobRowDecodeError({ jobId: row.id, reason: String(cause) }),
		),
		Effect.map((request) => ({
			id: JobId.make(row.id),
			sequence: row.sequence,
			sessionId: row.session_id,
			request,
			status: row.status,
			attemptCount: row.attempt_count,
			availableAt: row.available_at,
			leaseOwner: row.lease_owner,
			leaseExpiresAt: row.lease_expires_at,
			causationEventId: row.causation_event_id,
			correlationId: row.correlation_id,
			lastError: row.last_error,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			completedAt: row.completed_at,
		})),
	);

const nowIso = DateTime.nowAsDate.pipe(
	Effect.map((date) => date.toISOString()),
);

const isoAfter = (millis: number) =>
	DateTime.nowAsDate.pipe(
		Effect.map((date) => new Date(date.getTime() + millis).toISOString()),
	);

export interface JobLedger {
	/** Inserts jobs, ignoring ids that already exist. Returns the inserted count. */
	readonly enqueue: (
		jobs: ReadonlyArray<PendingJob>,
	) => Effect.Effect<number, JobLedgerError>;
	/**
	 * Atomically claims the oldest pending job that is available now and whose
	 * session has no running job. Returns `null` when nothing is claimable.
	 */
	readonly claimNext: (input: {
		/** Leave these job kinds pending until their execution prerequisites are ready. */
		readonly excludedKinds?: ReadonlyArray<JobKind>;
		readonly workerId: string;
		readonly leaseMs: number;
		/** Only claim jobs that became available at least this long ago. */
		readonly minAgeMs?: number;
		readonly sessionId?: string;
		/**
		 * Also claim `waiting` jobs parked before this timestamp. They need an
		 * explicit retry; a job that parks itself again after this timestamp is
		 * not claimed by the same drain.
		 */
		readonly includeWaitingBefore?: string | null;
	}) => Effect.Effect<Job | null, JobLedgerError>;
	/** Renew only a still-live claim. Claim owners must be unique per acquisition. */
	readonly renew: (input: {
		readonly jobId: JobId;
		readonly workerId: string;
		readonly leaseMs: number;
	}) => Effect.Effect<boolean, JobLedgerError>;
	/** Expired claims re-enter recovery; provider delivery fences prevent blind resend. */
	readonly reclaimExpired: Effect.Effect<number, JobLedgerError>;
	/** Marks a running job succeeded. `false` when this owner no longer holds it. */
	readonly succeed: (input: {
		readonly jobId: JobId;
		readonly workerId: string;
	}) => Effect.Effect<boolean, JobLedgerError>;
	/** Returns a running job to `pending` after a delay. */
	readonly retry: (input: {
		readonly jobId: JobId;
		readonly workerId: string;
		readonly delayMs: number;
		readonly error: string;
	}) => Effect.Effect<boolean, JobLedgerError>;
	/**
	 * Parks a running job as `waiting`: it stays claimable by an explicit
	 * drain or boot recovery but not by background loops.
	 */
	readonly hold: (input: {
		readonly jobId: JobId;
		readonly workerId: string;
		readonly error: string;
	}) => Effect.Effect<boolean, JobLedgerError>;
	/** Marks a running job failed for good. */
	readonly fail: (input: {
		readonly jobId: JobId;
		readonly workerId: string;
		readonly error: string;
	}) => Effect.Effect<boolean, JobLedgerError>;
	/** Cancels every pending or running job of the given kinds for a session. */
	readonly cancelUnsettled: (input: {
		readonly sessionId: string;
		readonly kinds: ReadonlyArray<JobKind>;
		readonly reason: string;
	}) => Effect.Effect<ReadonlyArray<JobId>, JobLedgerError>;
	/**
	 * Called once at process start. Jobs left `running` by a dead process and
	 * jobs parked as `waiting` are requeued when their kind is replayable and
	 * cancelled otherwise, so boot recovery retries them exactly once.
	 */
	readonly reconcileAfterProcessLoss: Effect.Effect<
		{ readonly requeued: number; readonly cancelled: number },
		JobLedgerError
	>;
	/** Earliest `availableAt` among pending jobs, or `null` when none exist. */
	readonly nextAvailableAt: Effect.Effect<string | null, JobLedgerError>;
	readonly hasRunning: (
		sessionId: string,
	) => Effect.Effect<boolean, JobLedgerError>;
	readonly unsettledCount: Effect.Effect<number, JobLedgerError>;
	readonly get: (jobId: JobId) => Effect.Effect<Job | null, JobLedgerError>;
	readonly listBySession: (
		sessionId: string,
	) => Effect.Effect<ReadonlyArray<Job>, JobLedgerError>;
}

export const makeSqlJobLedger = (sql: SqlClient.SqlClient): JobLedger => {
	const enqueue: JobLedger["enqueue"] = Effect.fn("JobLedger.enqueue")(
		function* (jobs) {
			if (jobs.length === 0) return 0;
			const now = yield* nowIso;
			let inserted = 0;
			for (const job of jobs) {
				const requestJson = yield* encodeRequest(job.request).pipe(
					Effect.orDie,
				);
				const rows = yield* sql<{ readonly id: string }>`
					INSERT OR IGNORE INTO jobs (
						id, session_id, kind, request_json, status, attempt_count,
						available_at, causation_event_id, correlation_id,
						created_at, updated_at
					)
					VALUES (
						${job.id}, ${job.sessionId}, ${job.request._tag}, ${requestJson},
						'pending', 0, ${now}, ${job.causationEventId}, ${job.correlationId},
						${now}, ${now}
					)
					RETURNING id
				`;
				inserted += rows.length;
			}
			return inserted;
		},
	);

	const claimNext: JobLedger["claimNext"] = Effect.fn("JobLedger.claimNext")(
		function* ({
			workerId,
			leaseMs,
			minAgeMs = 0,
			sessionId,
			includeWaitingBefore = null,
			excludedKinds = [],
		}) {
			const now = yield* nowIso;
			const availableBefore = yield* isoAfter(-minAgeMs);
			const leaseExpiresAt = yield* isoAfter(leaseMs);
			const rows = yield* sql<JobRow>`
				UPDATE jobs
				SET status = 'running',
					lease_owner = ${workerId},
					lease_expires_at = ${leaseExpiresAt},
					attempt_count = attempt_count + 1,
					last_error = NULL,
					updated_at = ${now}
				WHERE sequence = (
					SELECT candidate.sequence
					FROM jobs AS candidate
					WHERE (
							(candidate.status = 'pending'
								AND candidate.available_at <= ${availableBefore})
							OR (candidate.status = 'waiting'
								AND candidate.updated_at < ${includeWaitingBefore ?? ""})
						)
						AND (${sessionId ?? null} IS NULL OR candidate.session_id = ${sessionId ?? null})
						AND candidate.kind NOT IN (SELECT value FROM json_each(${JSON.stringify(excludedKinds)}))
						AND NOT EXISTS (
							SELECT 1 FROM jobs AS active
							WHERE active.session_id = candidate.session_id
								AND active.status = 'running'
						)
					ORDER BY candidate.sequence ASC
					LIMIT 1
				)
				RETURNING ${sql.literal(JOB_COLUMNS)}
			`;
			const row = rows[0];
			return row === undefined ? null : yield* decodeRow(row);
		},
	);

	const renew: JobLedger["renew"] = Effect.fn("JobLedger.renew")(function* ({
		jobId,
		workerId,
		leaseMs,
	}) {
		const now = yield* nowIso;
		const expires = yield* isoAfter(leaseMs);
		const rows = yield* sql<{ readonly id: string }>`
   UPDATE jobs SET lease_expires_at = ${expires}, updated_at = ${now}
   WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${workerId}
    AND lease_expires_at > ${now}
   RETURNING id
  `;
		return rows.length > 0;
	});
	const reclaimExpired: JobLedger["reclaimExpired"] = Effect.gen(function* () {
		const now = yield* nowIso;
		const rows = yield* sql<{ readonly id: string }>`
   UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
    available_at = ${now}, updated_at = ${now}, last_error = 'Claim expired; delivery requires reconciliation.'
   WHERE status = 'running' AND lease_expires_at <= ${now}
   RETURNING id
  `;
		return rows.length;
	});

	const succeed: JobLedger["succeed"] = Effect.fn("JobLedger.succeed")(
		function* ({ jobId, workerId }) {
			const now = yield* nowIso;
			const rows = yield* sql<{ readonly id: string }>`
				UPDATE jobs
				SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
					completed_at = ${now}, updated_at = ${now}
				WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${workerId} AND lease_expires_at > ${now}
				RETURNING id
			`;
			return rows.length > 0;
		},
	);

	const retry: JobLedger["retry"] = Effect.fn("JobLedger.retry")(function* ({
		jobId,
		workerId,
		delayMs,
		error,
	}) {
		const now = yield* nowIso;
		const availableAt = yield* isoAfter(delayMs);
		const rows = yield* sql<{ readonly id: string }>`
			UPDATE jobs
			SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
				available_at = ${availableAt}, last_error = ${error}, updated_at = ${now}
			WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${workerId} AND lease_expires_at > ${now}
			RETURNING id
		`;
		return rows.length > 0;
	});

	const hold: JobLedger["hold"] = Effect.fn("JobLedger.hold")(function* ({
		jobId,
		workerId,
		error,
	}) {
		const now = yield* nowIso;
		const rows = yield* sql<{ readonly id: string }>`
			UPDATE jobs
			SET status = 'waiting', lease_owner = NULL, lease_expires_at = NULL,
				available_at = ${now}, last_error = ${error}, updated_at = ${now}
			WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${workerId} AND lease_expires_at > ${now}
			RETURNING id
		`;
		return rows.length > 0;
	});

	const fail: JobLedger["fail"] = Effect.fn("JobLedger.fail")(function* ({
		jobId,
		workerId,
		error,
	}) {
		const now = yield* nowIso;
		const rows = yield* sql<{ readonly id: string }>`
			UPDATE jobs
			SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
				last_error = ${error}, completed_at = ${now}, updated_at = ${now}
			WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${workerId} AND lease_expires_at > ${now}
			RETURNING id
		`;
		return rows.length > 0;
	});

	const cancelUnsettled: JobLedger["cancelUnsettled"] = Effect.fn(
		"JobLedger.cancelUnsettled",
	)(function* ({ sessionId, kinds, reason }) {
		if (kinds.length === 0) return [];
		const now = yield* nowIso;
		const rows = yield* sql<{ readonly id: string }>`
			UPDATE jobs
			SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
				last_error = ${reason}, completed_at = ${now}, updated_at = ${now}
			WHERE session_id = ${sessionId}
				AND status IN ('pending', 'waiting', 'running')
				AND kind IN ${sql.in([...kinds])}
			RETURNING id
		`;
		return rows.map((row) => JobId.make(row.id));
	});

	const reconcileAfterProcessLoss: JobLedger["reconcileAfterProcessLoss"] =
		Effect.gen(function* () {
			const now = yield* nowIso;
			const requeued = yield* sql<{ readonly id: string }>`
				UPDATE jobs
				SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
					available_at = ${now},
					last_error = 'Requeued after the previous server process ended.',
					updated_at = ${now}
				WHERE status IN ('running', 'waiting')
					AND kind IN ${sql.in([...REPLAYABLE_JOB_KINDS])}
				RETURNING id
			`;
			const cancelled = yield* sql<{ readonly id: string }>`
				UPDATE jobs
				SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
					last_error = 'Cancelled because the server process ended before the job completed.',
					completed_at = ${now}, updated_at = ${now}
				WHERE status IN ('pending', 'waiting', 'running')
					AND kind NOT IN ${sql.in([...REPLAYABLE_JOB_KINDS])}
				RETURNING id
			`;
			return { requeued: requeued.length, cancelled: cancelled.length };
		});

	const nextAvailableAt: JobLedger["nextAvailableAt"] = sql<{
		readonly available_at: string | null;
	}>`
		SELECT MIN(available_at) AS available_at FROM jobs WHERE status = 'pending'
	`.pipe(Effect.map((rows) => rows[0]?.available_at ?? null));

	const hasRunning: JobLedger["hasRunning"] = (sessionId) =>
		sql<{ readonly present: number }>`
  SELECT EXISTS(SELECT 1 FROM jobs WHERE session_id = ${sessionId} AND status = 'running') AS present
 `.pipe(Effect.map((rows) => rows[0]?.present === 1));

	const unsettledCount: JobLedger["unsettledCount"] = sql<{
		readonly count: number;
	}>`
		SELECT COUNT(*) AS count FROM jobs
		WHERE status IN ('pending', 'waiting', 'running')
	`.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

	const get: JobLedger["get"] = (jobId) =>
		sql<JobRow>`
			SELECT ${sql.literal(JOB_COLUMNS)} FROM jobs WHERE id = ${jobId} LIMIT 1
		`.pipe(
			Effect.flatMap((rows) =>
				rows[0] === undefined ? Effect.succeed(null) : decodeRow(rows[0]),
			),
		);

	const listBySession: JobLedger["listBySession"] = (sessionId) =>
		sql<JobRow>`
			SELECT ${sql.literal(JOB_COLUMNS)} FROM jobs
			WHERE session_id = ${sessionId}
			ORDER BY sequence ASC
		`.pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)));

	return {
		enqueue,
		claimNext,
		renew,
		reclaimExpired,
		succeed,
		retry,
		hold,
		fail,
		cancelUnsettled,
		reconcileAfterProcessLoss,
		nextAvailableAt,
		unsettledCount,
		hasRunning,
		get,
		listBySession,
	};
};

export { isReplayableJobKind };
