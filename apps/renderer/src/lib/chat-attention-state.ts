import "@zuse/i18n/english/chat";
import type { SessionPresentation } from "@zuse/client-runtime/session-presentation";
import type {
	Message,
	PermissionRequest,
	SessionId,
	SessionInteraction,
} from "@zuse/contracts";
import { message } from "@zuse/i18n";

export type ChatAttentionState =
	| "idle"
	| "running"
	| "quiet"
	| "unavailable"
	| "disconnected"
	| "checking"
	| "planReady"
	| "question"
	| "permission";

const priority: Record<ChatAttentionState, number> = {
	idle: 0,
	running: 1,
	checking: 2,
	quiet: 3,
	disconnected: 4,
	unavailable: 5,
	planReady: 6,
	question: 7,

	permission: 8,
};

/** Health comes from the shared server-observation presentation, never elapsed client time. */
export const executionAttentionState = (
	running: boolean,
	health: SessionPresentation["health"] = "healthy",
): ChatAttentionState => {
	if (!running) return "idle";
	switch (health) {
		case "stalled":
			return "quiet";
		case "unavailable":
			return "unavailable";
		case "disconnected":
			return "disconnected";
		case "unknown":
			return "checking";
		default:
			return "running";
	}
};

export const executionAttentionLabel = (
	state: ChatAttentionState,
): string | null => {
	switch (state) {
		case "quiet":
			return message("chat:attention_quiet");
		case "unavailable":
			return message("chat:attention_unavailable");
		case "disconnected":
			return message("chat:attention_disconnected");
		case "checking":
			return message("chat:attention_checking");
		default:
			return null;
	}
};

const itemIdOf = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

export const mergeChatAttentionStates = (
	states: ReadonlyArray<ChatAttentionState>,
): ChatAttentionState =>
	states.reduce<ChatAttentionState>(
		(best, next) => (priority[next] > priority[best] ? next : best),
		"idle",
	);

export const deriveChatAttentionState = (
	messages: ReadonlyArray<Pick<Message, "content">>,
	running: boolean,
	interactions: ReadonlyArray<SessionInteraction>,
	health?: SessionPresentation["health"],
): ChatAttentionState => {
	if (interactions.some((interaction) => interaction._tag === "Question")) {
		return "question";
	}
	const completedTools = new Set<string>();

	for (const message of messages) {
		const content = message.content;
		if (content._tag === "tool_result") {
			const itemId = itemIdOf(content.itemId);
			if (itemId !== null) completedTools.add(itemId);
		}
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message === undefined) continue;
		const content = message.content;
		if (content._tag !== "tool_use") continue;
		if (content.tool !== "ExitPlanMode") continue;
		const itemId = itemIdOf(content.itemId);
		if (
			itemId !== null &&
			!completedTools.has(itemId) &&
			!interactions.some(
				(i) =>
					i._tag === "Plan" && i.id === itemId && i.recoveryState !== undefined,
			)
		)
			return "planReady";
	}

	return executionAttentionState(running, health);
};

/**
 * Attention contributed by *live permission prompts*. Unlike plan mode —
 * whose `ExitPlanMode` approval rides in as a `tool_use` message and surfaces
 * via `deriveChatAttentionState` ("planReady") — ordinary supervised-mode
 * permission requests need both a durable timeline interaction and a live
 * provider callback. The permission stream exposes only requests with that
 * callback, so it is the actionability authority for badges and controls. This
 * also keeps recovered requests quarantined after a server restart.
 *
 * `ExitPlanMode` is deliberately skipped here so plan mode keeps its dedicated
 * "planReady" icon instead of being double-counted as a generic permission.
 */
export const derivePermissionAttention = (
	requests: ReadonlyArray<PermissionRequest>,
	sessionIds: ReadonlySet<SessionId>,
): ChatAttentionState => {
	for (const req of requests) {
		if (!sessionIds.has(req.sessionId)) continue;
		if (req.kind._tag === "Other" && req.kind.tool === "ExitPlanMode") continue;
		return "permission";
	}
	return "idle";
};

/** Short status text shared by sidebar rows, pills, and hover cards. */
export const chatAttentionLabel = (
	state: ChatAttentionState,
	creationPending = false,
): string => {
	if (creationPending) return "Starting agent";
	switch (state) {
		case "running":
			return "Working";
		case "question":
			return "Awaiting input";
		case "permission":
			return "Needs approval";
		case "planReady":
			return "Plan ready";
		case "idle":
			return "Inactive";
		default:
			return executionAttentionLabel(state) ?? "Inactive";
	}
};

/** Unseen output draws attention once every session in the chat has settled. */
export const chatRowIsUnread = (
	selected: boolean,
	unseenOutput: boolean,
	busy: boolean,
	permission: boolean,
): boolean => !selected && (permission || (!busy && unseenOutput));
