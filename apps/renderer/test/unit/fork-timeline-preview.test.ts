import {
	decodeSessionTimelineCacheEntry,
	encodeSessionTimelineCacheEntry,
	makeSessionTimelineCacheEntry,
} from "@zuse/client-runtime/session-timeline-cache";
import {
	EnvironmentId,
	Message,
	MessageId,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { emptyTimelineProjection } from "@zuse/domain/projectors/timeline-reducer";
import { expect, test } from "vitest";
import { forkTimelinePreview } from "../../src/lib/fork-timeline-preview.ts";

const parent = SessionId.make("parent");
const child = SessionId.make("child");
const message = (id: string) =>
	Message.make({
		id: MessageId.make(id),
		sessionId: parent,
		role: "assistant",
		content: { _tag: "assistant", text: id },
		createdAt: new Date(0),
	});
test("previews only the fork prefix with child IDs and no inherited running state", () => {
	const source = SessionTimelineProjection.make({
		...emptyTimelineProjection(),
		status: "running",
		messages: [message("first"), message("point"), message("later")],
	});
	const preview = forkTimelinePreview(source, MessageId.make("point"), child);
	expect(preview?.messages.map((item) => [item.id, item.sessionId])).toEqual([
		["fork:child:first", "child"],
		["fork:child:point", "child"],
	]);
	expect(preview?.status).toBe("idle");
	expect(preview?.activeTurn).toBeNull();
	expect(preview?.queue.items).toEqual([]);
	expect(preview?.interactions).toEqual([]);
	expect(preview?.olderMessageSequence).toBeNull();
	expect(source.messages[0]?.sessionId).toBe("parent");
	expect(source.status).toBe("running");
	if (!preview) throw new Error("missing preview");
	const entry = makeSessionTimelineCacheEntry({
		ref: { environmentId: EnvironmentId.make("new-machine"), sessionId: child },
		projection: preview,
		cursor: { epoch: "fork-preview:new-machine", version: 0 },
	});
	expect(
		decodeSessionTimelineCacheEntry(encodeSessionTimelineCacheEntry(entry))
			.projection.messages,
	).toEqual(preview.messages);
});
test("does not show unrelated history when the selected fork point is absent", () => {
	expect(
		forkTimelinePreview(
			SessionTimelineProjection.make({
				...emptyTimelineProjection(),
				messages: [message("other")],
			}),
			MessageId.make("missing"),
			child,
		),
	).toBeNull();
});
