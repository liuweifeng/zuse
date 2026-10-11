import { describe, expect, test } from "vitest";
import { synthesizeBackfill } from "../../../src/engine/backfill.js";

const session = {
	sessionId: "session-1",
	chatId: "chat-1",
	projectId: "project-1",
	title: "Title",
	providerId: "provider-1",
	model: "model-1",
	status: "idle",
	providerThread: null,
	runtimeMode: "approval-required",
	agentsJson: null,
	worktreeId: null,
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	queuePaused: false,
	createdAt: 10,
	updatedAt: 10,
	archivedAt: null,
	deletedAt: null,
} as const;

describe("synthesizeBackfill", () => {
	test("creates deterministic lifecycle and message events per session", () => {
		const contentJson = '{"text":"kept byte-for-byte"}';
		const events = synthesizeBackfill({
			sessions: [
				{
					...session,
					title: "Existing title",
					archivedAt: 50,
				},
			],
			messages: [
				{
					rowId: 2,
					messageId: "message-2",
					sessionId: "session-1",
					role: "assistant",
					kind: "text",
					contentJson,
					parentItemId: "message-1",
					createdAt: 30,
				},
				{
					rowId: 1,
					messageId: "message-1",
					sessionId: "session-1",
					role: "user",
					kind: "text",
					contentJson: "{}",
					parentItemId: null,
					createdAt: 30,
				},
			],
			existingEventIds: new Set(),
			existingMessageIds: new Set(["message-1"]),
		});

		expect(events.map((event) => event.event._tag)).toEqual([
			"SessionCreated",
			"MessagePersisted",
			"SessionArchived",
			"SessionTitleSet",
		]);
		expect(events.map((event) => event.eventId)).toEqual([
			"backfill:session-created:session-1",
			"backfill:message:message-2",
			"backfill:session-archived:session-1",
			"backfill:session-title:session-1",
		]);
		expect(events[1]?.event).toMatchObject({
			_tag: "MessagePersisted",
			contentJson,
			parentItemId: "message-1",
		});
		expect(events[0]?.event).toMatchObject({
			_tag: "SessionCreated",
			providerId: "provider-1",
			model: "model-1",
			runtimeMode: "approval-required",
			permissionMode: "default",
		});
	});

	test("skips deterministic events already appended by a partial attempt", () => {
		const events = synthesizeBackfill({
			sessions: [
				{
					...session,
					deletedAt: 20,
				},
			],
			messages: [],
			existingEventIds: new Set(["backfill:session-created:session-1"]),
			existingMessageIds: new Set(),
		});

		expect(events.map((event) => event.event._tag)).toEqual([
			"SessionTitleSet",
			"SessionDeleted",
		]);
	});
});
