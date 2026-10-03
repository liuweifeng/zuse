import { matchesClaudeForkPoint } from "@zuse/agents/drivers/claude-fork-point";
import {
	ChatId,
	type Message,
	type MessageContent,
	type MessageId,
	SessionId,
	SessionStartError,
} from "@zuse/contracts";
import { joinId } from "@zuse/domain/agent-engine/ids";
import { proposedPlanMarkdownFromContent } from "@zuse/utils/proposed-plan";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	ConversationOperations,
	TranscriptServiceShape,
} from "../services/conversation-services.ts";
import { makeContextLinkOperations } from "./context-link-operations.ts";
import {
	shouldIncludeInTranscript,
	transcriptToMarkdown,
} from "./conversation-message-mapping.ts";
import { type MessageRow, messageFromRow } from "./conversation-records.ts";
import { makeForkConstruction } from "./fork-construction.ts";
import { readForkSnapshot } from "./fork-snapshot.ts";

interface PersistedMessage {
	readonly message: Message;
	readonly sequence: number;
}

export interface TranscriptOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly sessionDomain?: Pick<
		import("@zuse/domain/engine/session-domain").SessionDomainApi,
		"dispatchTransactionally"
	>;
	readonly admitConstruction?: <A>(work: Effect.Effect<A>) => Effect.Effect<A>;
	readonly createChat: ConversationOperations["createChat"];
	readonly createSession: ConversationOperations["createSession"];
	readonly lookupChat: ConversationOperations["getChat"];
	readonly lookupSession: ConversationOperations["getSession"];
	readonly persistMessage: (
		sessionId: Parameters<ConversationOperations["getSession"]>[0],
		content: MessageContent,
		idOverride?: MessageId,
	) => Effect.Effect<PersistedMessage>;
}

export const makeTranscriptOperations = (
	options: TranscriptOperationsOptions,
): TranscriptServiceShape & {
	readonly recoverForks: () => Effect.Effect<void>;
} => {
	const { sql, createChat, lookupSession, persistMessage } = options;
	const construction = makeForkConstruction(options);

	const continueExternalThread: ConversationOperations["continueExternalThread"] =
		(input) =>
			Effect.gen(function* () {
				const result = yield* createChat({
					...input,
					providerThread: input.providerThread,
				});
				return {
					chat: result.chat,
					initialSession: result.initialSession,
				};
			});

	const importExternalMessages: ConversationOperations["importExternalMessages"] =
		(sessionId, messages) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const imported: Message[] = [];
				for (const content of messages) {
					const persisted = yield* persistMessage(sessionId, content);
					imported.push(persisted.message);
				}
				return imported;
			});

	const exportTranscript: ConversationOperations["exportTranscript"] = (
		sessionId,
		uptoMessageId,
	) =>
		Effect.gen(function* () {
			const session = yield* lookupSession(sessionId);
			const rows = yield* sql<MessageRow>`
				SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
				FROM messages WHERE session_id = ${sessionId}
				ORDER BY created_at ASC, sequence ASC
			`.pipe(Effect.orDie);
			let slice = rows;
			if (uptoMessageId !== undefined) {
				const index = rows.findIndex((row) => row.id === uptoMessageId);
				if (index !== -1) slice = rows.slice(0, index + 1);
			}
			return transcriptToMarkdown(session.title, slice.map(messageFromRow));
		});

	const latestPlan: ConversationOperations["latestPlan"] = (sessionId) =>
		Effect.gen(function* () {
			const session = yield* lookupSession(sessionId);
			const rows = yield* sql<MessageRow>`
				SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
				FROM messages
				WHERE session_id = ${sessionId} AND kind IN ('tool_use', 'assistant')
				ORDER BY created_at DESC, sequence DESC
			`.pipe(Effect.orDie);
			for (const row of rows) {
				const content = messageFromRow(row).content;
				const markdown = proposedPlanMarkdownFromContent(content);
				if (markdown !== null) return markdown;
				// Compatibility for plan items persisted before providers preserved
				// their semantic marker. Codex remains in plan mode while the final
				// plan awaits feedback, and its newest assistant row is that plan.
				if (
					session.providerId === "codex" &&
					session.permissionMode === "plan" &&
					content._tag === "assistant" &&
					content.text.trim().length > 0
				) {
					return content.text.trim();
				}
			}
			return null;
		});

	const forkSession: ConversationOperations["forkSession"] = (input) =>
		Effect.gen(function* () {
			const commandId = input.commandId ?? `fork:${crypto.randomUUID()}`;
			const sessionId =
				input.initialSessionId ??
				SessionId.make(joinId("fork-session", commandId));
			const sourceSnapshot = input.sourceSnapshot;
			if (sourceSnapshot === undefined) {
				const previous = yield* construction.resume(sessionId, {
					...input,
					commandId,
				});
				if (previous !== null) return previous;
			}
			const snapshot =
				sourceSnapshot === undefined
					? undefined
					: yield* Effect.try({
							try: () =>
								readForkSnapshot(
									sourceSnapshot.databasePath,
									sourceSnapshot.chatId,
									input.sourceSessionId,
								),
							catch: () =>
								new SessionStartError({
									providerId: input.providerId ?? "codex",
									reason: "Machine fork source could not be read",
								}),
						});
			const { source, rows } =
				snapshot ??
				(yield* sql
					.withTransaction(
						Effect.gen(function* () {
							const source = yield* lookupSession(input.sourceSessionId);
							const rows = yield* sql<MessageRow>`
					SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
					FROM messages WHERE session_id=${input.sourceSessionId}
					ORDER BY created_at ASC, sequence ASC
				`.pipe(Effect.orDie);
							return { source, rows };
						}),
					)
					.pipe(Effect.catchTag("SqlError", Effect.die)));
			const forkIndex = rows.findIndex((row) => row.id === input.fromMessageId);
			if (forkIndex === -1) {
				return yield* Effect.fail(
					new SessionStartError({
						providerId: source.providerId,
						reason: `fork message ${input.fromMessageId} not found in session ${input.sourceSessionId}`,
					}),
				);
			}

			const providerId = input.providerId ?? source.providerId;
			const model = input.model ?? source.model;
			const isTail = forkIndex === rows.length - 1;
			// Native forks are safe only with a provider-supported immutable cutoff
			// correlated to this exact visible message. A mutable thread ID is not enough.
			const providerCanFork =
				providerId === "claude" &&
				matchesClaudeForkPoint(
					source.providerThread?.nativeHeadRef?.nativeId ?? null,
					messageFromRow(rows[forkIndex]!).content,
				);
			const forkMode: "resume" | "copy" =
				isTail &&
				providerId === source.providerId &&
				providerCanFork &&
				source.providerThread !== null
					? "resume"
					: "copy";
			const title =
				input.title?.trim() || `Fork of ${source.title}`.slice(0, 120);
			const transcript = rows
				.slice(0, forkIndex + 1)
				.map(messageFromRow)
				.filter((message) => shouldIncludeInTranscript(message.content));
			const providerThread =
				forkMode === "resume" && source.providerThread !== null
					? {
							nativeThreadId:
								source.providerThread.nativeThreadRef.nativeId ?? "",
							nativeHeadId:
								source.providerThread.nativeHeadRef?.nativeId ?? null,
						}
					: undefined;

			return yield* construction.construct({
				sessionId: sessionId,
				chatId:
					input.destination === "tab"
						? source.chatId
						: (input.chatId ?? ChatId.make(joinId("fork-chat", commandId))),
				projectId: sourceSnapshot?.projectId ?? source.projectId,
				commandId,
				sourceSessionId: input.sourceSessionId,
				destination: input.destination,
				providerId,
				model,
				title,
				runtimeMode: source.runtimeMode,
				permissionMode: source.permissionMode,
				toolSearch: source.toolSearch,
				worktreeId: input.worktreeId ?? null,
				providerThread,
				forkedFromSessionId: sourceSnapshot === undefined ? source.id : null,
				forkedFromMessageId: input.fromMessageId,
				forkMode,
				messages: transcript.map(({ id, content }) => ({ id, content })),
			});
		});

	return {
		...makeContextLinkOperations(options),
		recoverForks: construction.recover,
		forkConstructions: construction.list,
		retryFork: construction.retry,
		cancelFork: construction.cancel,
		continueExternalThread,
		importExternalMessages,
		forkSession,
		exportTranscript,
		latestPlan,
	};
};
