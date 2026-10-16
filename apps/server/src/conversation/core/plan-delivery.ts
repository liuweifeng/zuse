import { AgentItemId, AgentTurnId, SessionId } from "@zuse/contracts";
import type { InputRequestOwner } from "@zuse/domain/agent-engine/input-owner";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { PlanResponse, planResponseMessageId } from "./plan-response.ts";
import type { SessionOperationsOptions } from "./session-operations.ts";

interface Delivery {
	readonly session_id: string;
	readonly item_id: string;
	readonly turn_id: string | null;
	readonly response_json: string;
	readonly status: "delivering" | "accepted" | "uncertain" | "committed";
}

/** Only a provider acknowledgement permits rebuilding a public success receipt. */
export const makePlanDelivery = (
	sql: SqlClient.SqlClient,
	options: Pick<SessionOperationsOptions, "persistMessage" | "ndjsonAppend">,
) => {
	const read = (sessionId: SessionId, itemId: AgentItemId) =>
		sql<Delivery>`SELECT * FROM plan_response_deliveries WHERE session_id=${sessionId} AND item_id=${itemId}`.pipe(
			Effect.map((rows) => rows[0]),
			Effect.orDie,
		);
	const begin = (
		sessionId: SessionId,
		itemId: AgentItemId,
		turnId: AgentTurnId | null,
		owner: InputRequestOwner,
		response: PlanResponse,
	) =>
		sql`INSERT INTO plan_response_deliveries (session_id,item_id,turn_id,response_json,owner_json,status,created_at,updated_at) VALUES (${sessionId},${itemId},${turnId},${JSON.stringify(response)},${JSON.stringify(owner)},'delivering',${Date.now()},${Date.now()}) ON CONFLICT(session_id,item_id) DO NOTHING`.pipe(
			Effect.orDie,
			Effect.asVoid,
		);
	const uncertain = (sessionId: SessionId, itemId: AgentItemId) =>
		sql`UPDATE plan_response_deliveries SET status='uncertain',updated_at=${Date.now()} WHERE session_id=${sessionId} AND item_id=${itemId} AND status='delivering'`.pipe(
			Effect.orDie,
			Effect.asVoid,
		);
	const accepted = (sessionId: SessionId, itemId: AgentItemId) =>
		sql`UPDATE plan_response_deliveries SET status='accepted',updated_at=${Date.now()} WHERE session_id=${sessionId} AND item_id=${itemId} AND status='delivering'`.pipe(
			Effect.orDie,
			Effect.asVoid,
		);
	const commit = (delivery: Delivery) =>
		Effect.gen(function* () {
			if (delivery.status !== "accepted" && delivery.status !== "committed")
				return;
			const response = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(PlanResponse),
			)(delivery.response_json).pipe(Effect.orDie);
			const sessionId = SessionId.make(delivery.session_id),
				itemId = AgentItemId.make(delivery.item_id);
			const persisted = yield* options.persistMessage(
				sessionId,
				{ _tag: "tool_result", itemId, output: response, isError: false },
				planResponseMessageId(sessionId, itemId),
				delivery.turn_id === null ? null : AgentTurnId.make(delivery.turn_id),
			);
			yield* sql`UPDATE plan_response_deliveries SET status='committed',updated_at=${Date.now()} WHERE session_id=${sessionId} AND item_id=${itemId}`.pipe(
				Effect.orDie,
			);
			if (persisted.changed) yield* options.ndjsonAppend(sessionId, persisted);
		});
	const recover = Effect.gen(function* () {
		yield* sql`UPDATE plan_response_deliveries SET status='uncertain',updated_at=${Date.now()} WHERE status='delivering'`.pipe(
			Effect.orDie,
		);
		while (true) {
			const rows =
				yield* sql<Delivery>`SELECT * FROM plan_response_deliveries WHERE status='accepted' ORDER BY session_id,item_id LIMIT 100`.pipe(
					Effect.orDie,
				);
			for (const row of rows) yield* commit(row);
			if (rows.length < 100) return;
		}
	});
	return { read, begin, accepted, uncertain, commit, recover };
};
