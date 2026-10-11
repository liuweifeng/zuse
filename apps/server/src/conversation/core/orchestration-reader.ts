import {
	ORCHESTRATION_READ_LIMIT,
	ORCHESTRATION_TEXT_LIMIT,
	type OrchestrationReadInput,
} from "@zuse/agents/drivers/orchestration-discovery";
import type { SqlSessionQueriesApi } from "@zuse/domain/queries/sql-session-queries";
import { Effect, Schema } from "effect";
import { messageContentToText } from "./conversation-message-mapping.ts";
import { messageFromRecord } from "./conversation-records.ts";

const ReadInput = Schema.Struct({
	sessionId: Schema.NonEmptyString,
	limit: Schema.optional(
		Schema.Int.check(
			Schema.isBetween({ minimum: 1, maximum: ORCHESTRATION_READ_LIMIT }),
		),
	),
	afterMessageId: Schema.optional(Schema.String),
	messageId: Schema.optional(Schema.NonEmptyString),
	textOffset: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	),
	maxTextChars: Schema.optional(
		Schema.Int.check(
			Schema.isBetween({ minimum: 1, maximum: ORCHESTRATION_TEXT_LIMIT }),
		),
	),
	view: Schema.optional(Schema.Literals(["messages", "activity"])),
});

/** Bounded projection reads. Cursors are checked in the target session, never interpreted as offsets. */
export const makeOrchestrationReader = (
	queries: Pick<
		SqlSessionQueriesApi,
		"get" | "messageBoundary" | "messageList"
	>,
	projectId: string,
) =>
	Effect.fn("Orchestration.readPage")(function* (raw: OrchestrationReadInput) {
		const input = yield* Schema.decodeUnknownEffect(ReadInput)(raw);
		const session = yield* queries.get(input.sessionId);
		if (session.projectId !== projectId)
			return yield* Effect.fail(
				new Error("The session does not belong to this project."),
			);
		if (input.messageId !== undefined && input.afterMessageId !== undefined)
			return yield* Effect.fail(
				new Error("Use messageId or afterMessageId, not both."),
			);
		if (input.textOffset !== undefined && input.messageId === undefined)
			return yield* Effect.fail(new Error("textOffset requires messageId."));
		const cursorId = input.messageId ?? input.afterMessageId;
		const boundary = cursorId
			? yield* queries.messageBoundary(input.sessionId, cursorId)
			: null;
		if (cursorId && boundary === null)
			return yield* Effect.fail(
				new Error(
					"Message cursor no longer exists in this session. Read again without a cursor.",
				),
			);
		const single = input.messageId !== undefined;
		const incremental = input.afterMessageId !== undefined || single;
		const limit = single ? 1 : (input.limit ?? 20);
		const rows = yield* queries.messageList({
			sessionId: input.sessionId,
			afterSequence:
				single && boundary ? boundary.sequence - 1 : boundary?.sequence,
			throughSequence: single ? boundary?.sequence : undefined,
			direction: incremental ? "asc" : "desc",
			limit: limit + 1,
			kinds:
				input.view === "messages"
					? [
							"user",
							"user_rich",
							"assistant",
							"ui_spec",
							"error",
							"subagent_summary",
						]
					: undefined,
		});
		const selected = rows.slice(0, limit);
		if (!incremental) selected.reverse();
		// A whole page has one budget, not a separate potentially huge budget per item.
		let remaining = input.maxTextChars ?? ORCHESTRATION_TEXT_LIMIT;
		const messages = [];
		for (const record of selected) {
			if (remaining === 0) break;
			const message = messageFromRecord(record);
			const text =
				message.content._tag === "thinking" && message.content.redacted
					? "[redacted thinking]"
					: messageContentToText(message.content);
			const offset = input.textOffset ?? 0;
			if (offset > text.length)
				return yield* Effect.fail(
					new Error(
						"textOffset is beyond the current message text. Read again from offset 0.",
					),
				);
			const chunk = text.slice(offset, offset + remaining);
			const truncated = offset + chunk.length < text.length;
			messages.push({
				id: message.id as string,
				role: message.role,
				kind: message.content._tag,
				text: chunk,
				truncated,
				nextTextOffset: truncated ? offset + chunk.length : null,
			});
			remaining -= chunk.length;
		}
		return {
			ok: true as const,
			status: session.status,
			messages,
			nextMessageId: messages.at(-1)?.id ?? input.afterMessageId ?? null,
			hasMore:
				(incremental && rows.length > limit) ||
				messages.length < selected.length,
			// Recent reads can page backwards through the existing UI API; the agent's
			// incremental cursor always proceeds forwards from its last returned item.
		};
	});
