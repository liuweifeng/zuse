import { expect, test } from "vitest";
import type { SessionEvent } from "../../../src/core/events.ts";
import {
	evolve,
	evolveAll,
	initialSessionState,
} from "../../../src/core/state.ts";

const message = (
	id: string,
	revision = 1,
): Extract<SessionEvent, { readonly _tag: "MessagePersisted" }> => ({
	_tag: "MessagePersisted",
	messageId: id,
	turnId: null,
	role: "assistant",
	kind: "assistant",
	contentJson: JSON.stringify({ _tag: "assistant", text: id }),
	parentItemId: null,
	checkpointRevision: revision,
	checkpointFinal: revision > 1,
	createdAt: 1,
});

test("batched replay preserves prior states across messages, revisions and interaction events", () => {
	const before = evolve(initialSessionState, message("retained"));
	const events: SessionEvent[] = [
		message("first"),
		message("second"),
		message("retained", 2),
		{ _tag: "PermissionExpired", requestId: "permission", expiredAt: 2 },
		message("third"),
		{
			...message("answer"),
			kind: "user_question_answer",
			contentJson: JSON.stringify({
				_tag: "user_question_answer",
				itemId: "question",
				answers: [],
			}),
		},
		message("fourth"),
	];
	const replayed = evolveAll(before, events);
	expect(replayed).toEqual(events.reduce(evolve, before));
	expect([...before.messageIds]).toEqual(["retained"]);
	expect(before.messageCheckpoints.get("retained")).toEqual({
		revision: 1,
		final: false,
	});
	expect(initialSessionState.messageIds.size).toBe(0);
	expect(evolveAll(replayed, [message("later")]).messageIds.has("later")).toBe(
		true,
	);
	expect(replayed.messageIds.has("later")).toBe(false);
	expect(replayed.resolvedQuestionIds.has("question")).toBe(true);
});

test("rollback replay removes deleted message ownership before new history is persisted", () => {
	const before = evolveAll(initialSessionState, [
		message("keep", 2),
		message("remove", 2),
	]);
	const event: SessionEvent = {
		_tag: "TurnsRolledBack",
		throughOrdinal: 0,
		messageSequence: 1,
		removedMessageIds: ["remove"],
		rolledBackAt: 3,
	};
	const after = evolve(before, event);
	expect([...after.messageIds]).toEqual(["keep"]);
	expect(after.messageCheckpoints.has("remove")).toBe(false);
	expect(before.messageCheckpoints.has("remove")).toBe(true);
	expect(
		evolveAll(before, [event, message("remove", 1)]).messageCheckpoints.get(
			"remove",
		),
	).toEqual({ revision: 1, final: false });
});
