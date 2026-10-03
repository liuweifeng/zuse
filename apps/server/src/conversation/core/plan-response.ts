import {
	type AgentItemId,
	AgentTurnId,
	MessageContent,
	MessageId,
	PlanApprovalOutcome,
	type SessionId,
} from "@zuse/contracts";
import { InputRequestOwner } from "@zuse/domain/agent-engine/input-owner";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { Effect, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

const decodeContent = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);
const decodeOwner = Schema.decodeUnknownResult(
	Schema.fromJsonString(InputRequestOwner),
);
export const PlanResponse = Schema.Struct({
	outcome: PlanApprovalOutcome,
	feedback: Schema.optional(Schema.String),
});
export type PlanResponse = typeof PlanResponse.Type;
const decodeResponse = Schema.decodeUnknownResult(PlanResponse);
export const planResponseMessageId = (
	sessionId: SessionId,
	itemId: AgentItemId,
) => MessageId.make(`plan-response:${structuralTupleKey(sessionId, itemId)}`);

/** Read original attribution and accepted receipts, never infer authority from the current turn. */
export const readPlanResponse = (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
	itemId: AgentItemId,
) =>
	Effect.gen(function* () {
		const requests = yield* sql<{
			turn_id: string | null;
			owner_json: string | null;
		}>`
 SELECT m.turn_id, json_extract(e.payload_json, '$.inputOwner') AS owner_json FROM messages m
 LEFT JOIN events e ON e.sequence = m.sequence AND e.stream_id = m.session_id AND e.stream_kind = 'session' AND e.type = 'MessagePersisted'
 WHERE m.session_id = ${sessionId} AND m.kind = 'tool_use' AND json_valid(m.content_json)
 AND json_extract(m.content_json, '$.tool') = 'ExitPlanMode' AND json_extract(m.content_json, '$.itemId') = ${itemId}
 ORDER BY m.sequence, m.id LIMIT 1`;
		if (requests.length === 0) return { _tag: "unavailable" as const };
		const results = yield* sql<{
			content_json: string;
		}>`SELECT content_json FROM messages WHERE session_id = ${sessionId}
 AND kind = 'tool_result' AND json_valid(content_json) AND json_extract(content_json,'$.itemId') = ${itemId} LIMIT 2`;
		if (results.length > 0) {
			const first = results[0];
			const content =
				results.length === 1 && first !== undefined
					? decodeContent(first.content_json)
					: undefined;
			if (
				content === undefined ||
				Result.isFailure(content) ||
				content.success._tag !== "tool_result" ||
				content.success.isError
			)
				return { _tag: "invalid" as const };
			const response = decodeResponse(content.success.output);
			return Result.isFailure(response)
				? { _tag: "invalid" as const }
				: { _tag: "resolved" as const, response: response.success };
		}
		const request = requests[0];
		const owner =
			request?.owner_json == null ? undefined : decodeOwner(request.owner_json);
		if (request === undefined || owner === undefined || Result.isFailure(owner))
			return { _tag: "unavailable" as const };
		return {
			_tag: "pending" as const,
			owner: owner.success,
			turnId:
				request.turn_id === null ? null : AgentTurnId.make(request.turn_id),
		};
	});
