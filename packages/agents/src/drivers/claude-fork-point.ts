import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageContent } from "@zuse/contracts";

interface ClaudeForkPoint {
	readonly uuid: string;
	readonly itemId: string;
}
const prefix = "claude-assistant:";

/** Both identities are needed: SDK UUID is the native cutoff; itemId proves the visible boundary. */
export const claudeForkPoint = (message: SDKMessage): string | null => {
	if (message.type !== "assistant" || message.parent_tool_use_id != null)
		return null;
	const blocks = message.message.content;
	const last = blocks.at(-1);
	if (last?.type !== "text" || !message.uuid || !message.message.id)
		return null;
	return `${prefix}${encodeURIComponent(message.uuid)}:${encodeURIComponent(`${message.message.id}:text:${blocks.length - 1}`)}`;
};

export const decodeClaudeForkPoint = (
	cursor: string | null,
): ClaudeForkPoint | null => {
	if (cursor === null || !cursor.startsWith(prefix)) return null;
	const parts = cursor.slice(prefix.length).split(":");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	try {
		return {
			uuid: decodeURIComponent(parts[0]),
			itemId: decodeURIComponent(parts[1]),
		};
	} catch {
		return null;
	}
};

export const matchesClaudeForkPoint = (
	cursor: string | null,
	content: MessageContent,
): boolean => {
	const point = decodeClaudeForkPoint(cursor);
	return (
		point !== null &&
		content._tag === "assistant" &&
		content.itemId === point.itemId
	);
};

/** A requested native fork must never silently read the source's newer tail. */
export const claudeResumeOptions = (
	thread: string | null,
	fork: boolean,
	head: string | null,
) => {
	if (thread === null) return {};
	if (!fork) return { resume: thread };
	const point = decodeClaudeForkPoint(head);
	if (point === null)
		throw new Error("Native fork requires an immutable assistant boundary");
	return { resume: thread, forkSession: true, resumeSessionAt: point.uuid };
};
