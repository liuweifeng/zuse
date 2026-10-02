import { describe, expect, test } from "vitest";

import {
	isReplayableJobKind,
	JOB_KINDS,
	jobsForSessionEvent,
} from "../../../src/agent-engine/jobs.js";
import type { StoredEvent } from "../../../src/engine/dispatch.js";

const record = (
	event: StoredEvent["event"],
	eventId = "event-1",
): StoredEvent => ({
	eventId,
	correlationId: "correlation-1",
	causationEventId: null,
	streamId: "session-1",
	streamVersion: 1,
	sequence: 1,
	event,
});

describe("jobs implied by session events", () => {
	test("a provider turn request implies a send job with a derived id", () => {
		const jobs = jobsForSessionEvent(
			record({
				_tag: "ProviderTurnRequested",
				turnId: "turn-1",
				requestedAt: 1,
				providerInputJson: '{"text":"hi"}',
				providerStartJson: "{}",
			}),
		);
		expect(jobs).toEqual([
			{
				id: "job:event-1:0",
				sessionId: "session-1",
				causationEventId: "event-1",
				correlationId: "correlation-1",
				request: {
					_tag: "provider.turn.send",
					turnId: "turn-1",
					providerInputJson: '{"text":"hi"}',
					providerStartJson: "{}",
				},
			},
		]);
	});

	test("deriving twice from the same event yields the same job id", () => {
		const event = record({
			_tag: "TurnInterruptRequested",
			turnId: "turn-1",
			requestedAt: 5,
		});
		expect(jobsForSessionEvent(event)[0]?.id).toBe(
			jobsForSessionEvent(event)[0]?.id,
		);
	});

	test("session creation implies no job", () => {
		expect(
			jobsForSessionEvent(
				record({
					_tag: "SessionCreated",
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					createdAt: 1,
					providerStartJson: "{}",
				}),
			),
		).toEqual([]);
	});

	test("preserves the stop's exact provider residency in the durable job", () => {
		expect(
			jobsForSessionEvent(
				record({
					_tag: "ProviderStopRequested",
					providerId: "claude",
					providerSessionId: "old-process",
					requestedAt: 9,
				}),
			)[0]?.request,
		).toEqual({
			_tag: "provider.stop",
			providerSessionId: "old-process",
			requestedAt: 9,
		});
	});

	test("stop, interrupt, and successor events map to their jobs", () => {
		expect(
			jobsForSessionEvent(
				record({
					_tag: "ProviderStopRequested",
					providerId: "claude",
					requestedAt: 9,
				}),
			)[0]?.request,
		).toEqual({ _tag: "provider.stop", requestedAt: 9 });
		expect(
			jobsForSessionEvent(
				record({
					_tag: "ScheduledSuccessorReady",
					predecessorTurnId: "turn-1",
					turnId: "turn-2",
					queueId: "queue-1",
					inputJson: "{}",
					readyAt: 2,
				}),
			)[0]?.request,
		).toEqual({
			_tag: "provider.successor.start",
			turnId: "turn-2",
			queueId: "queue-1",
			inputJson: "{}",
		});
	});

	test("events without side effects imply no jobs", () => {
		expect(
			jobsForSessionEvent(
				record({
					_tag: "TurnSettled",
					turnId: "turn-1",
					outcome: "completed",
					settledAt: 3,
				}),
			),
		).toEqual([]);
	});

	test("every job kind is classified for process loss", () => {
		for (const kind of JOB_KINDS) {
			expect(typeof isReplayableJobKind(kind)).toBe("boolean");
		}
	});
});
