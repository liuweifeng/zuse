import {
	type Chat,
	EnvironmentId,
	type Session,
	type SessionId,
} from "@zuse/contracts";
import { useMemo } from "react";
import {
	type ChatAttentionState,
	deriveChatAttentionState,
	derivePermissionAttention,
	executionAttentionState,
	mergeChatAttentionStates,
} from "./chat-attention-state.ts";
import { useEnvironmentPermissions } from "./environment-permissions-client-bus.ts";
import { useEnvironmentQuestionAttachments } from "./environment-question-attachments-client-bus.ts";
import { useEnvironmentShellResource } from "./environment-shell-client-bus.ts";
import { filterActionableQuestionInteractions } from "./question-actionability.ts";
import { isSessionRuntimeBusy } from "./session-runtime-state.ts";
import { useRendererSessionTimelines } from "./session-timeline-hooks.ts";

export type ChatAttention = {
	readonly chatSessions: ReadonlyArray<Session>;
	readonly sessionIds: ReadonlyArray<SessionId>;
	readonly attentionState: ChatAttentionState;
	readonly permissionAttention: ChatAttentionState;
	readonly busy: boolean;
};

/**
 * Live attention for one chat in its specified environment, merged across every
 * non-archived session (tab): running agents, open questions, unfinished
 * plans, and pending permission prompts. A pending chat creation counts as
 * running so the row lights up before the first session exists.
 */
export function useChatAttention(
	chat: Pick<Chat, "id">,
	environmentId: string,
	creationPending: boolean,
): ChatAttention {
	const shell = useEnvironmentShellResource(
		EnvironmentId.make(environmentId),
		"cache-only",
	);
	const sessionsByProject = shell.data?.sessionsByProject;
	const chatSessions = useMemo(
		() =>
			Object.values(sessionsByProject ?? {})
				.flat()
				.filter((row) => row.chatId === chat.id && row.archivedAt === null),
		[sessionsByProject, chat.id],
	);
	const sessionIds = useMemo(
		() => chatSessions.map((session) => session.id),
		[chatSessions],
	);
	const timelineRefs = useMemo(
		() =>
			sessionIds.map((sessionId) => ({
				environmentId: EnvironmentId.make(environmentId),
				sessionId,
			})),
		[environmentId, sessionIds],
	);
	const timelines = useRendererSessionTimelines(timelineRefs, "cache-only");
	const questionAttachmentsByKey =
		useEnvironmentQuestionAttachments(EnvironmentId.make(environmentId)).data
			?.attachmentsByKey ?? {};
	const runningAttention = useMemo(
		() =>
			mergeChatAttentionStates(
				timelines.map((timeline) =>
					executionAttentionState(
						isSessionRuntimeBusy(timeline.runtime),
						timeline.presentation.health,
					),
				),
			),
		[timelines],
	);
	const messageAttention = useMemo(
		() =>
			mergeChatAttentionStates(
				timelines.map((timeline) =>
					deriveChatAttentionState(
						timeline.messages,
						false,
						filterActionableQuestionInteractions(
							timeline.ref.sessionId,
							timeline.presentation.interactions.map(
								(item) => item.interaction,
							),
							questionAttachmentsByKey,
						),
					),
				),
			),
		[timelines, questionAttachmentsByKey],
	);
	const sessionIdSet = useMemo(() => new Set(sessionIds), [sessionIds]);

	const permissionRequests =
		useEnvironmentPermissions(EnvironmentId.make(environmentId)).data
			?.requestsById ?? {};
	const permissionAttention = derivePermissionAttention(
		Object.values(permissionRequests),
		sessionIdSet,
	);
	const attentionState = mergeChatAttentionStates([
		creationPending ? "running" : "idle",
		runningAttention,
		messageAttention,
		permissionAttention,
	]);
	return {
		chatSessions,
		sessionIds,
		attentionState,
		permissionAttention,
		busy:
			creationPending ||
			timelines.some((timeline) => isSessionRuntimeBusy(timeline.runtime)),
	};
}
