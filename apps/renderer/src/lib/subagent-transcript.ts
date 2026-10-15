import type { AgentItemId, Message } from "@zuse/contracts";
import {
	type ChatTimelineRow,
	deriveChatTimelineRows,
} from "./chat-timeline-rows.ts";

/** Re-rooted children keep their identity so memoized rows stay settled. */
const rerooted = new WeakMap<Message, Message>();

/** A subagent's own messages read as top-level work inside its transcript. */
const rerootChild = (message: Message, parentItemId: AgentItemId): Message => {
	const content = message.content;
	if (!("parentItemId" in content) || content.parentItemId !== parentItemId) {
		return message;
	}
	const cached = rerooted.get(message);
	if (cached !== undefined) return cached;
	const { parentItemId: _, ...rest } = content;
	const next = { ...message, content: rest as Message["content"] };
	rerooted.set(message, next);
	return next;
};

/**
 * Subagent transcripts follow the main chat's turn rules: tools gather into
 * activity trees while the agent works, and a settled run with a final reply
 * collapses its work behind a summary. A summary the agent never wrote into
 * its transcript closes the run as its final reply.
 */
export function deriveSubagentTimelineRows({
	parent,
	parentItemId,
	children,
	summaryText,
	live,
}: {
	readonly parent: Message;
	readonly parentItemId: AgentItemId;
	readonly children: ReadonlyArray<Message>;
	readonly summaryText: string | null;
	readonly live: boolean;
}): ChatTimelineRow[] {
	const messages = children.map((child) => rerootChild(child, parentItemId));
	const summary = summaryText?.trim() ?? "";
	const summaryInTranscript = messages.some(
		(message) =>
			message.content._tag === "assistant" &&
			message.content.text.trim() === summary,
	);
	if (summary.length > 0 && !summaryInTranscript) {
		messages.push({
			...parent,
			id: `${parent.id}:summary` as Message["id"],
			role: "assistant",
			content: { _tag: "assistant", text: summary },
			createdAt: messages.at(-1)?.createdAt ?? parent.createdAt,
		});
	}
	// The parent's working row and plan gate do not apply to a nested run.
	return deriveChatTimelineRows({
		messages,
		inFlight: live,
		awaitingPlanApproval: true,
	});
}
