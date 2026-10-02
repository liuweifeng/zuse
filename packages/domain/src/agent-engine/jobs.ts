import { JobId, ProviderTurnReference } from "@zuse/contracts";
import { Schema } from "effect";

import type { SessionEvent } from "../core/events.js";
import type { StoredEvent } from "../engine/dispatch.js";
import { joinId } from "./ids.js";

/**
 * Durable jobs.
 *
 * A job is one unit of provider-facing work that a committed event implies:
 * send a turn, interrupt it, stop the provider, start a scheduled successor.
 * Session creation implies no job: a provider is opened by the first turn's
 * send, and boot recovery reopens sessions that were mid-flight. Jobs are rows in the
 * `jobs` table, inserted in the same SQLite transaction as the events that
 * imply them, so a committed event can never lose its side effect and a side
 * effect can never run for an event that did not commit.
 *
 * Job ids derive from the causing event, so re-deriving jobs for the same
 * event (a retried command, a replayed transaction) collapses on insert.
 */

export const JobRequest = Schema.Union([
	Schema.TaggedStruct("provider.stop", {
		providerSessionId: Schema.optional(Schema.String),
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("provider.turn.recover", {
		turnId: Schema.String,
		attemptId: Schema.String,
		sourceAttemptId: Schema.String,
		reference: ProviderTurnReference,
	}),
	Schema.TaggedStruct("provider.turn.send", {
		turnId: Schema.String,
		/** Absent only on historical requests written before attempt ownership. */
		attemptId: Schema.optional(Schema.String),
		providerInputJson: Schema.String,
		providerStartJson: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("provider.turn.interrupt", {
		turnId: Schema.String,
		/** Absent only on historical requests written before attempt ownership. */
		attemptId: Schema.optional(Schema.String),
		requestedAt: Schema.Number,
	}),
	Schema.TaggedStruct("provider.successor.start", {
		turnId: Schema.String,
		queueId: Schema.String,
		inputJson: Schema.String,
	}),
]);
export type JobRequest = typeof JobRequest.Type;
export type JobKind = JobRequest["_tag"];

export const JOB_KINDS = [
	"provider.stop",
	"provider.turn.send",
	"provider.turn.recover",
	"provider.turn.interrupt",
	"provider.successor.start",
] as const satisfies ReadonlyArray<JobKind>;

/**
 * Kinds whose execution can safely start over after the server process dies
 * mid-flight. Their handlers re-read durable state and are no-ops once the
 * work they describe has already happened.
 */
export const REPLAYABLE_JOB_KINDS = [
	"provider.stop",
	"provider.turn.send",
	"provider.turn.recover",
	"provider.turn.interrupt",
	"provider.successor.start",
] as const satisfies ReadonlyArray<JobKind>;

/**
 * Kinds bound to an in-memory handle of the process that claimed them. They
 * are cancelled, never resumed, after process loss. Empty today; kept as the
 * exhaustive partner of `REPLAYABLE_JOB_KINDS` so a new kind must choose.
 */
export const NON_REPLAYABLE_JOB_KINDS =
	[] as const satisfies ReadonlyArray<JobKind>;

type Partitioned =
	| (typeof REPLAYABLE_JOB_KINDS)[number]
	| (typeof NON_REPLAYABLE_JOB_KINDS)[number];
const assertExhaustive: [JobKind] extends [Partitioned] ? true : never = true;
void assertExhaustive;

export const isReplayableJobKind = (kind: JobKind): boolean =>
	(REPLAYABLE_JOB_KINDS as ReadonlyArray<JobKind>).includes(kind);

/**
 * `pending` jobs are claimed by any worker loop once available. `waiting`
 * jobs failed in a way only a user action or a restart should retry (for
 * example a provider that cannot start); background loops leave them alone
 * and an explicit drain or boot recovery claims them.
 */
export const JobStatus = Schema.Literals([
	"pending",
	"waiting",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);
export type JobStatus = typeof JobStatus.Type;

export type Job = {
	readonly id: JobId;
	readonly sequence: number;
	readonly sessionId: string;
	readonly request: JobRequest;
	readonly status: JobStatus;
	readonly attemptCount: number;
	readonly availableAt: string;
	readonly leaseOwner: string | null;
	readonly leaseExpiresAt: string | null;
	readonly causationEventId: string | null;
	readonly correlationId: string | null;
	readonly lastError: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly completedAt: string | null;
};

export type PendingJob = {
	readonly id: JobId;
	readonly sessionId: string;
	readonly request: JobRequest;
	readonly causationEventId: string;
	readonly correlationId: string;
};

const jobIdForEvent = (record: StoredEvent<SessionEvent>, index: number) =>
	JobId.make(joinId("job", record.eventId, index));

/**
 * The jobs a committed session event implies. Pure, so the mapping can be
 * unit tested and replayed deterministically.
 */
export const jobsForSessionEvent = (
	record: StoredEvent<SessionEvent>,
): ReadonlyArray<PendingJob> => {
	const requests = jobRequestsForEvent(record.event);
	return requests.map((request, index) => ({
		id: jobIdForEvent(record, index),
		sessionId: record.streamId,
		request,
		causationEventId: record.eventId,
		correlationId: record.correlationId,
	}));
};

const jobRequestsForEvent = (
	event: SessionEvent,
): ReadonlyArray<JobRequest> => {
	switch (event._tag) {
		case "ProviderStopRequested":
			return [
				{
					_tag: "provider.stop",
					requestedAt: event.requestedAt,
					...(event.providerSessionId === undefined
						? {}
						: { providerSessionId: event.providerSessionId }),
				},
			];
		case "ProviderRecoveryRequested":
			return [
				{
					_tag: "provider.turn.recover",
					turnId: event.turnId,
					attemptId: event.attemptId,
					sourceAttemptId: event.sourceAttemptId,
					reference: event.reference,
				},
			];
		case "ProviderTurnRequested":
			return [
				{
					_tag: "provider.turn.send",
					turnId: event.turnId,
					...(event.attemptId === undefined
						? {}
						: { attemptId: event.attemptId }),
					providerInputJson: event.providerInputJson,
					...(event.providerStartJson === undefined
						? {}
						: { providerStartJson: event.providerStartJson }),
				},
			];
		case "TurnInterruptRequested":
			return [
				{
					_tag: "provider.turn.interrupt",
					turnId: event.turnId,
					...(event.attemptId === undefined
						? {}
						: { attemptId: event.attemptId }),
					requestedAt: event.requestedAt,
				},
			];
		case "ScheduledSuccessorReady":
			return [
				{
					_tag: "provider.successor.start",
					turnId: event.turnId,
					queueId: event.queueId,
					inputJson: event.inputJson,
				},
			];
		default:
			return [];
	}
};
