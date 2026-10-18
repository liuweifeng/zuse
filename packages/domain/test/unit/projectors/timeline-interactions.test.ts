import {
	AgentItemId,
	ComposerInput,
	Message,
	MessageId,
	SessionId,
	SessionTimelineFrame,
} from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { timelineEventFromDomain } from "../../../src/projectors/timeline-projection.ts";
import {
	applyTimelineEvent,
	emptyTimelineProjection,
} from "../../../src/projectors/timeline-reducer.ts";

const sessionId = SessionId.make("session-interactions");

describe("durable session interactions", () => {
	it.each([
		"QueuedTurnEnqueued",
		"QueuedTurnUpdated",
	] as const)("serializes %s with a materialized attachment through the timeline RPC codec", (_tag) => {
		const input = ComposerInput.make({
			text: "first image",
			attachments: [
				{
					id: "uploaded-image",
					mimeType: "image/png",
					originalName: "image.png",
				},
			],
			fileRefs: [],
			skillRefs: [],
			annotations: [],
			asGoal: false,
		});
		const event = timelineEventFromDomain(
			sessionId,
			_tag === "QueuedTurnEnqueued"
				? {
						_tag,
						queueId: "startup-queue",
						inputJson: JSON.stringify(input),
						position: 0,
						createdAt: 1,
						ready: true,
					}
				: {
						_tag,
						queueId: "startup-queue",
						inputJson: JSON.stringify(input),
						updatedAt: 2,
						ready: true,
					},
		);
		const frame: SessionTimelineFrame = {
			kind: "event",
			sessionId,
			streamVersion: 3,
			eventId: "startup-update",
			cursor: { epoch: "startup", version: 3 },
			event,
		};
		const codec = Schema.Array(SessionTimelineFrame);
		const decoded = Schema.decodeUnknownSync(codec)(
			JSON.parse(JSON.stringify(Schema.encodeSync(codec)([frame]))),
		);
		expect(decoded[0]).toEqual(frame);
		const queuedInput =
			event._tag === "QueueEnqueued"
				? event.item.input
				: event._tag === "QueueUpdated"
					? event.input
					: null;
		expect(queuedInput).toBeInstanceOf(ComposerInput);
	});

	it("replays a queued author and retains that author when the prompt is edited", () => {
		const actor = { subject: "author", membershipId: "original-membership" };
		const input = {
			text: "queued",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
			actor,
		};
		const enqueued = timelineEventFromDomain(sessionId, {
			_tag: "QueuedTurnEnqueued",
			queueId: "queue",
			inputJson: JSON.stringify(input),
			position: 0,
			createdAt: 1,
			ready: true,
		});
		const projection = applyTimelineEvent(emptyTimelineProjection(), enqueued);
		expect(projection.queue.items[0]?.actor).toEqual(actor);
		const updated = timelineEventFromDomain(sessionId, {
			_tag: "QueuedTurnUpdated",
			queueId: "queue",
			inputJson: JSON.stringify({ ...input, text: "edited" }),
			updatedAt: 2,
			ready: true,
		});
		const replay = applyTimelineEvent(projection, updated);
		expect(replay.queue.items[0]).toMatchObject({
			actor,
			input: { text: "edited" },
		});
	});
	it("restores an unanswered question from the timeline and settles it only on its answer", () => {
		const questions = [{ question: "Choose", options: ["A", "B"] }];
		const question = Message.make({
			id: MessageId.make("message-question"),
			sessionId,
			role: "assistant",
			content: {
				_tag: "user_question",
				itemId: "question-1" as never,
				questions,
			},
			createdAt: new Date("2026-08-23T00:00:00.000Z"),
		});
		const requested = applyTimelineEvent(emptyTimelineProjection(), {
			_tag: "MessagePersisted",
			message: question,
		});

		expect(requested.interactions).toEqual([
			expect.objectContaining({
				_tag: "Question",
				id: "question-1",
				questions,
			}),
		]);

		const answer = Message.make({
			id: MessageId.make("message-answer"),
			sessionId,
			role: "user",
			content: {
				_tag: "user_question_answer",
				itemId: "question-1" as never,
				answers: [{ questionIndex: 0, selected: [1] }],
			},
			createdAt: new Date("2026-08-23T00:00:01.000Z"),
		});
		const resolved = applyTimelineEvent(requested, {
			_tag: "MessagePersisted",
			message: answer,
		});

		expect(resolved.interactions).toEqual([]);
	});

	it("settles a cancelled question without inventing an answer message", () => {
		const requestedAt = Date.parse("2026-08-23T00:00:00.000Z");
		const question = Message.make({
			id: MessageId.make("message-cancelled-question"),
			sessionId,
			role: "assistant",
			content: {
				_tag: "user_question",
				itemId: "question-cancelled" as never,
				questions: [{ question: "Continue?", options: ["Yes", "No"] }],
			},
			createdAt: new Date(requestedAt),
		});
		const requested = applyTimelineEvent(emptyTimelineProjection(), {
			_tag: "MessagePersisted",
			message: question,
		});
		const resolution = timelineEventFromDomain(sessionId, {
			_tag: "QuestionResolved",
			itemId: "question-cancelled",
			resolution: "cancelled",
			resolvedAt: requestedAt + 1,
		});
		const resolved = applyTimelineEvent(requested, resolution);

		expect(resolution).toEqual({
			_tag: "QuestionResolved",
			itemId: "question-cancelled",
			resolution: "cancelled",
		});
		expect(resolved.interactions).toEqual([]);
		expect(resolved.messages).toEqual([question]);
	});

	it("projects permission request and durable resolution events", () => {
		const requestedAt = Date.parse("2026-08-23T00:00:00.000Z");
		const request = {
			id: "permission-1",
			sessionId,
			kind: { _tag: "Bash", command: "git status" },
			requestedAt: new Date(requestedAt),
			forcePrompt: false,
		};
		const requestedEvent = timelineEventFromDomain(sessionId, {
			_tag: "PermissionRequested",
			requestId: request.id,
			turnId: "turn-1",
			payloadJson: JSON.stringify(request),
			requestedAt,
		});
		const requested = applyTimelineEvent(
			emptyTimelineProjection(),
			requestedEvent,
		);

		expect(requested.interactions).toEqual([
			expect.objectContaining({
				_tag: "Permission",
				id: request.id,
				request: expect.objectContaining({ kind: request.kind }),
			}),
		]);

		const expired = applyTimelineEvent(
			requested,
			timelineEventFromDomain(sessionId, {
				_tag: "PermissionExpired",
				requestId: request.id,
				expiredAt: requestedAt + 1,
			}),
		);
		expect(expired.interactions).toEqual([
			expect.objectContaining({
				_tag: "Permission",
				request: expect.objectContaining({ recoveryState: "expired" }),
			}),
		]);
		const resolvedEvent = timelineEventFromDomain(sessionId, {
			_tag: "PermissionResolved",
			requestId: request.id,
			decision: "AllowOnce",
			decisionJson: JSON.stringify({ _tag: "AllowOnce" }),
			resolvedAt: requestedAt + 1,
		});
		const resolved = applyTimelineEvent(requested, resolvedEvent);

		expect(resolved.interactions).toEqual([]);
	});
});

it("retains expiry through duplicate messages and dismisses without an answer", () => {
	const itemId = AgentItemId.make("expired-question");
	const event = {
		_tag: "MessagePersisted" as const,
		message: Message.make({
			id: MessageId.make("expired-message"),
			sessionId,
			role: "assistant",
			content: {
				_tag: "user_question",
				itemId,
				questions: [{ question: "Continue?", options: ["Yes"] }],
			},
			createdAt: new Date(1),
		}),
	};
	const requested = applyTimelineEvent(emptyTimelineProjection(), event);
	const expired = applyTimelineEvent(requested, {
		_tag: "QuestionExpired",
		itemId,
	});
	expect(expired.interactions).toEqual([
		expect.objectContaining({ id: itemId, recoveryState: "expired" }),
	]);
	expect(applyTimelineEvent(expired, event).interactions).toEqual(
		expired.interactions,
	);
	const dismissed = applyTimelineEvent(expired, {
		_tag: "QuestionResolved",
		itemId,
		resolution: "cancelled",
	});
	expect(dismissed.interactions).toEqual([]);
	expect(applyTimelineEvent(dismissed, event).interactions).toEqual([]);
});
