import {
	MessageId,
	SessionContextError,
	type SessionId,
} from "@zuse/contracts";
import { joinId } from "@zuse/domain/agent-engine/ids";
import { Effect } from "effect";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { renderHandoffContext } from "./context-handoff.ts";
import { makeContextLinks } from "./context-links.ts";
import { type MessageRow, messageFromRow } from "./conversation-records.ts";
import type { TranscriptOperationsOptions } from "./transcript-operations.ts";

export const makeContextLinkOperations = (
	options: TranscriptOperationsOptions,
) => {
	const { sql } = options;
	const links = makeContextLinks(sql);
	const failure = (message: string) => new SessionContextError({ message });
	const mergeBack: ConversationOperations["mergeBack"] = (input) =>
		Effect.gen(function* () {
			const id = joinId("merge-back", input.commandId);
			const previous = yield* links.get(id);
			if (previous !== null) {
				if (
					previous.sourceSessionId !== input.sessionId ||
					(input.throughMessageId !== undefined &&
						previous.sourceMessageId !== input.throughMessageId)
				)
					return yield* failure(
						"Merge command conflicts with its original result.",
					);
				return previous;
			}
			const source = yield* options.lookupSession(input.sessionId);
			const parentId = source.forkedFromSessionId;
			if (parentId === null)
				return yield* failure(
					"This conversation has no local fork parent to merge into.",
				);
			const parent = yield* options.lookupSession(parentId);
			if (parent.archivedAt !== null || parent.projectId !== source.projectId)
				return yield* failure("The fork parent is not available for merging.");
			const previousPoints = yield* sql<{
				sequence: number;
			}>`SELECT COALESCE(MAX(source_sequence),0) AS sequence FROM session_context_links WHERE kind='merge_back' AND source_session_id=${source.id} AND target_session_id=${parent.id}`;
			const previousSequence = previousPoints[0]?.sequence ?? 0;
			const prefix = `fork:${source.id}:`;
			const boundaries =
				input.throughMessageId === undefined
					? yield* sql<{
							id: MessageId;
							sequence: number;
						}>`SELECT id,sequence FROM messages WHERE session_id=${source.id} AND substr(id,1,length(${prefix}))<>${prefix} ORDER BY sequence DESC LIMIT 1`
					: yield* sql<{
							id: MessageId;
							sequence: number;
						}>`SELECT id,sequence FROM messages WHERE session_id=${source.id} AND id=${input.throughMessageId} AND substr(id,1,length(${prefix}))<>${prefix}`;
			const point = boundaries[0];
			if (point === undefined || point.sequence <= previousSequence)
				return yield* failure("There is no new fork context to merge.");
			const rows =
				yield* sql<MessageRow>`SELECT id,session_id,role,kind,content_json,parent_item_id,created_at FROM messages WHERE session_id=${source.id} AND sequence>${previousSequence} AND sequence<=${point.sequence} AND substr(id,1,length(${prefix}))<>${prefix} AND kind IN ('user','user_rich','assistant','tool_use','tool_result','subagent_summary') ORDER BY sequence DESC LIMIT 201`;
			if (rows.length === 0)
				return yield* failure("There is no new fork context to merge.");
			const contextText = renderHandoffContext(
				rows.slice(0, 200).reverse().map(messageFromRow),
				rows.length > 200,
			);
			const targetMessageId = MessageId.make(
				joinId("context-link-message", id),
			);
			const domain = options.sessionDomain;
			if (domain === undefined)
				return yield* failure("Context linking is unavailable.");
			return yield* domain.dispatchTransactionally(
				{
					commandId: id,
					streamId: parent.id,
					command: {
						_tag: "PersistMessage",
						messageId: targetMessageId,
						turnId: null,
						role: "user",
						kind: "user",
						parentItemId: null,
						createdAt: Date.now(),
						contentJson: JSON.stringify({
							_tag: "user",
							text: `Merged context from ${source.title}. This context will be available on the next turn.\n\n${contextText}`,
							origin: {
								chatId: source.chatId,
								sessionId: source.id,
								providerId: source.providerId,
							},
						}),
					},
				},
				() =>
					Effect.gen(function* () {
						// Both sides must stay writable until the message and context link commit.
						const blocked = yield* sql<{
							blocked: number;
						}>`SELECT EXISTS(SELECT 1 FROM session_fork_constructions WHERE session_id IN (${source.id},${parent.id}) AND completed_at IS NULL) OR EXISTS(SELECT 1 FROM session_checkpoint_restores WHERE session_id IN (${source.id},${parent.id}) AND completed_at IS NULL) AS blocked`;
						if (blocked[0]?.blocked === 1)
							return yield* failure(
								"Wait for fork construction or checkpoint restore to finish.",
							);
						const current = yield* sql<{
							sequence: number;
						}>`SELECT COALESCE(MAX(source_sequence),0) AS sequence FROM session_context_links WHERE kind='merge_back' AND source_session_id=${source.id} AND target_session_id=${parent.id}`;
						if ((current[0]?.sequence ?? 0) !== previousSequence)
							return yield* failure(
								"Another merge completed first. Retry to merge the remaining context.",
							);
						const pointStillExists =
							yield* sql`SELECT id FROM messages WHERE session_id=${source.id} AND id=${point.id} AND sequence=${point.sequence}`;
						if (pointStillExists.length === 0)
							return yield* failure(
								"The fork changed before the merge completed. Retry from its current history.",
							);
						return yield* links.capture({
							id,
							kind: "merge_back",
							sourceSessionId: source.id,
							targetSessionId: parent.id,
							targetMessageId,
							baseMessageId: source.forkedFromMessageId,
							sourceMessageId: point.id,
							sourceSequence: point.sequence,
							contextText,
						});
					}),
			);
		}).pipe(
			Effect.mapError((error) =>
				error instanceof SessionContextError
					? error
					: failure(
							"Context could not be merged. Refresh the conversations and retry.",
						),
			),
		);
	const contextLinks: ConversationOperations["contextLinks"] = (
		sessionId: SessionId,
	) =>
		options.lookupSession(sessionId).pipe(
			Effect.andThen(links.list(sessionId)),
			Effect.mapError(() => failure("Conversation context could not be read.")),
		);
	return { mergeBack, contextLinks };
};
