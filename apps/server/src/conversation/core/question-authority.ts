import { type AgentItemId, AgentTurnId, type SessionId } from "@zuse/contracts";
import {
	InputRequestOwner,
	ownsInputRequest,
} from "@zuse/domain/agent-engine/input-owner";
import { Effect, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

const decodeOwner = Schema.decodeUnknownResult(
	Schema.fromJsonString(InputRequestOwner),
);

/** Durable input ownership is independent of the currently selected/active turn. */
export const loadQuestionAuthority = (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
	itemId: AgentItemId,
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			owner_json: string | null;
			turn_id: string | null;
		}>`
			SELECT owner_json, turn_id FROM session_inputs
			WHERE session_id = ${sessionId} AND kind = 'question' AND request_id = ${itemId}
				AND status = 'pending' AND request_json IS NOT NULL
		`;
		const row = rows[0];
		if (row?.owner_json == null) return null;
		const owner = decodeOwner(row.owner_json);
		if (
			Result.isFailure(owner) ||
			!(yield* ownsInputRequest(sql, sessionId, owner.success))
		)
			return null;
		return {
			owner: owner.success,
			turnId: row.turn_id === null ? null : AgentTurnId.make(row.turn_id),
		};
	});
