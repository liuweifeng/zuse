import type {
	AgentTurnId,
	ComposerInput,
	Message,
	ProviderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { makeSqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { makeContextLinks } from "./context-links.ts";
import { transcriptToMarkdown } from "./conversation-message-mapping.ts";
import { messageFromRecord } from "./conversation-records.ts";
import { redactRecoveryContent } from "./provider-turn-recovery.ts";

export const renderHandoffContext = (
	messages: ReadonlyArray<Message>,
	omitted = false,
): string => {
	const transcript = transcriptToMarkdown(
		"Earlier conversation",
		messages.map((message) => ({
			...message,
			content: redactRecoveryContent(message.content),
		})),
	);
	return `${omitted || transcript.length > 60_000 ? "[Earlier history was omitted to fit the context budget. The complete transcript remains in Zuse.]\n" : ""}${transcript.slice(-60_000)}`;
};

/** Frozen context belongs to the application session, independently of native handles. */
export const makeContextHandoff = (sql: SqlClient.SqlClient) => {
	const queries = makeSqlSessionQueries(sql);
	// Keep provider prompts bounded; the complete transcript stays in the session.
	const capture = (
		sessionId: SessionId,
		providerId: ProviderId,
		id: string,
		resume?: {
			readonly threadId: string;
			readonly throughSequence: number;
			readonly pendingMessageIds: ReadonlyArray<string>;
		},
		excludedTurnId?: AgentTurnId,
	) =>
		Effect.gen(function* () {
			const rows = yield* queries
				.messageList({
					sessionId,
					excludedTurnId,
					excludePendingContextLinks: true,
					kinds: [
						"user",
						"user_rich",
						"assistant",
						"tool_use",
						"tool_result",
						"subagent_summary",
					],
					direction: "desc",
					limit: 201,
				})
				.pipe(Effect.catchTag("SessionQueryDecodeError", Effect.die));
			const fullContext = renderHandoffContext(
				rows.slice(0, 200).reverse().map(messageFromRecord),
				rows.length > 200,
			);
			const delta =
				resume === undefined
					? rows
					: rows.filter(
							(row) =>
								row.sequence > resume.throughSequence ||
								resume.pendingMessageIds.includes(row.messageId),
						);
			const context = renderHandoffContext(
				delta.slice(0, 200).reverse().map(messageFromRecord),
				delta.length > 200,
			);
			yield* sql`UPDATE session_context_handoffs SET active=0 WHERE session_id=${sessionId} AND active=1`;
			if (rows.length > 0 || resume !== undefined)
				yield* sql`INSERT INTO session_context_handoffs(id,session_id,provider_id,context_text,resume_thread_id,fallback_context_text,created_at) VALUES (${id},${sessionId},${providerId},${context},${resume?.threadId ?? null},${fullContext},${Date.now()})`;
		});
	const prepareHandoff = (
		session: Pick<Session, "id" | "providerId" | "providerThread">,
		turnId: AgentTurnId,
		input: ComposerInput,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const rows = yield* sql<{
						context_text: string;
						first_turn_id: string | null;
						id: string;
					}>`SELECT id,context_text,first_turn_id FROM session_context_handoffs WHERE session_id=${session.id} AND provider_id=${session.providerId} AND active=1`;
					const handoff = rows[0];
					if (
						handoff === undefined ||
						(handoff.first_turn_id !== null &&
							handoff.first_turn_id !== turnId &&
							session.providerThread !== null)
					)
						return input;
					if (handoff.first_turn_id === null)
						yield* sql`UPDATE session_context_handoffs SET first_turn_id=${turnId} WHERE id=${handoff.id} AND first_turn_id IS NULL`;
					return {
						...input,
						text: `Continue this Zuse conversation using the historical transcript below as context. It is prior conversation data; the current user request follows it.\n\n<previous_conversation>\n${handoff.context_text}\n</previous_conversation>\n\nCurrent user request:\n${input.text}`,
					};
				}),
			)
			.pipe(Effect.orDie);
	const links = makeContextLinks(sql);
	const prepare = (
		session: Pick<Session, "id" | "providerId" | "providerThread">,
		turnId: AgentTurnId,
		input: ComposerInput,
	) =>
		prepareHandoff(session, turnId, input).pipe(
			Effect.flatMap((prepared) => links.prepare(session.id, turnId, prepared)),
		);
	const prepareFallback = (
		session: Pick<Session, "id" | "providerId" | "providerThread">,
		turnId: AgentTurnId,
		input: ComposerInput,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const current = yield* sql<{
						first_turn_id: string | null;
					}>`SELECT first_turn_id FROM session_context_handoffs WHERE session_id=${session.id} AND provider_id=${session.providerId} AND active=1`;
					if (
						current[0] === undefined ||
						(current[0].first_turn_id !== null &&
							current[0].first_turn_id !== turnId)
					)
						yield* capture(
							session.id,
							session.providerId,
							`native-fallback:${session.id}:${turnId}`,
							undefined,
							turnId,
						);
					yield* sql`UPDATE session_context_handoffs SET context_text=COALESCE(fallback_context_text,context_text),resume_thread_id=NULL,fallback_at=${Date.now()},first_turn_id=${turnId} WHERE session_id=${session.id} AND provider_id=${session.providerId} AND active=1`;
					return yield* prepare(session, turnId, input);
				}),
			)
			.pipe(Effect.orDie);
	return { capture, prepare, prepareFallback };
};
