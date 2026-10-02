import {
	type Chat,
	type Message,
	type MessageContent,
	type MessageId,
	type Session,
	SessionStartError,
} from "@zuse/contracts";
import { forkMessageId } from "@zuse/domain/conversation/transcript";
import { proposedPlanMarkdownFromContent } from "@zuse/utils/proposed-plan";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
	ConversationOperations,
	TranscriptServiceShape,
} from "../services/conversation-services.ts";
import {
	shouldIncludeInTranscript,
	transcriptToMarkdown,
} from "./conversation-message-mapping.ts";
import { type MessageRow, messageFromRow } from "./conversation-records.ts";
import { readForkSnapshot } from "./fork-snapshot.ts";

interface PersistedMessage {
	readonly message: Message;
	readonly sequence: number;
}

export interface TranscriptOperationsOptions {
	readonly sql: SqlClient.SqlClient;
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
): TranscriptServiceShape => {
	const {
		sql,
		createChat,
		createSession,
		lookupChat,
		lookupSession,
		persistMessage,
	} = options;

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
			const sourceSnapshot = input.sourceSnapshot;
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
			const source =
				snapshot?.source ?? (yield* lookupSession(input.sourceSessionId));
			const rows =
				snapshot?.rows ??
				(yield* sql<MessageRow>`
				SELECT id, session_id, role, kind, content_json, parent_item_id, created_at
				FROM messages WHERE session_id = ${input.sourceSessionId}
				ORDER BY created_at ASC, sequence ASC
			`.pipe(Effect.orDie));
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
			const providerCanFork = providerId === "claude" || providerId === "codex";
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

			let chat: Chat;
			let session: Session;
			if (input.destination === "tab") {
				session = yield* createSession({
					chatId: source.chatId,
					providerId,
					model,
					title,
					runtimeMode: source.runtimeMode,
					permissionMode: source.permissionMode,
					toolSearch: source.toolSearch,
					background: true,
					providerThread,
					forkedFromSessionId: input.sourceSessionId,
					forkedFromMessageId: input.fromMessageId,
					forkFromResume: forkMode === "resume",
				});
				chat = yield* lookupChat(source.chatId).pipe(Effect.orDie);
			} else {
				const created = yield* createChat({
					projectId: input.sourceSnapshot?.projectId ?? source.projectId,
					chatId: input.chatId,
					initialSessionId: input.initialSessionId,
					commandId: input.commandId,
					providerId,
					model,
					title,
					worktreeId: input.worktreeId ?? null,
					runtimeMode: source.runtimeMode,
					permissionMode: source.permissionMode,
					toolSearch: source.toolSearch,
					providerThread,
					// Cross-machine ancestry is recorded in the workspace lineage; the
					// source session is not a row in this fresh database.
					forkedFromSessionId:
						sourceSnapshot === undefined ? input.sourceSessionId : null,
					forkedFromMessageId: input.fromMessageId,
					forkFromResume: forkMode === "resume",
				});
				chat = created.chat;
				session = created.initialSession;
			}
			for (const message of transcript) {
				// Stable IDs make interrupted machine-bootstrap imports replayable.
				const id = forkMessageId(session.id, message.id);
				const existing =
					yield* sql`SELECT id FROM messages WHERE id = ${id}`.pipe(
						Effect.orDie,
					);
				if (existing.length === 0)
					yield* persistMessage(session.id, message.content, id);
			}
			return { chat, session, forkMode };
		});

	return {
		continueExternalThread,
		importExternalMessages,
		forkSession,
		exportTranscript,
		latestPlan,
	};
};
