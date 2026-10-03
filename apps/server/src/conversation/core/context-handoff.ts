import type {
	AgentTurnId,
	ComposerInput,
	ProviderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { transcriptToMarkdown } from "./conversation-message-mapping.ts";
import { type MessageRow, messageFromRow } from "./conversation-records.ts";
import { redactRecoveryContent } from "./provider-turn-recovery.ts";

/** Frozen context belongs to the application session, independently of native handles. */
export const makeContextHandoff = (sql: SqlClient.SqlClient) => {
	// Keep provider prompts bounded; the complete transcript stays in the session.
	const maxCharacters = 60_000;
	const capture = (sessionId: SessionId, providerId: ProviderId, id: string) =>
		Effect.gen(function* () {
			const rows =
				yield* sql<MessageRow>`SELECT id,session_id,role,kind,content_json,parent_item_id,created_at FROM messages WHERE session_id=${sessionId} AND kind IN ('user','user_rich','assistant','tool_use','tool_result','subagent_summary') ORDER BY sequence DESC LIMIT 201`;
			const selected = rows
				.slice(0, 200)
				.reverse()
				.map(messageFromRow)
				.map((message) => ({
					...message,
					content: redactRecoveryContent(message.content),
				}));
			const transcript = transcriptToMarkdown("Earlier conversation", selected);
			const truncated = rows.length > 200 || transcript.length > maxCharacters;
			const context = `${truncated ? "[Earlier history was omitted to fit the context budget. The complete transcript remains in Zuse.]\n" : ""}${transcript.slice(-maxCharacters)}`;
			yield* sql`UPDATE session_context_handoffs SET active=0 WHERE session_id=${sessionId} AND active=1`;
			if (rows.length > 0)
				yield* sql`INSERT INTO session_context_handoffs(id,session_id,provider_id,context_text,created_at) VALUES (${id},${sessionId},${providerId},${context},${Date.now()})`;
		});
	const prepare = (
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
	return { capture, prepare };
};
