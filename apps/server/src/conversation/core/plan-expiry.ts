import { AgentItemId, SessionId } from "@zuse/contracts";
import {
	InputRequestOwner,
	ownsInputRequest,
} from "@zuse/domain/agent-engine/input-owner";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type { makePlanDelivery } from "./plan-delivery.ts";

class PlanStillOwned extends Schema.TaggedErrorClass<PlanStillOwned>()(
	"PlanStillOwned",
	{},
) {}
const decodeOwner = Schema.decodeUnknownResult(
	Schema.fromJsonString(InputRequestOwner),
);
export const makePlanExpiry = (
	sql: SqlClient.SqlClient,
	domain: SessionDomainApi,
	provider: Pick<ProviderServiceShape, "acknowledgePlanResponse">,
	journal: ReturnType<typeof makePlanDelivery>,
	serialize: (
		sessionId: SessionId,
		itemId: AgentItemId,
		work: Effect.Effect<void>,
	) => Effect.Effect<void>,
) => {
	let afterSession = "",
		afterItem = "";
	return Effect.gen(function* () {
		const rows = yield* sql<{
			session_id: string;
			request_id: string;
			owner_json: string | null;
		}>`SELECT session_id,request_id,owner_json FROM session_inputs WHERE kind='plan' AND status='pending' AND (session_id>${afterSession} OR (session_id=${afterSession} AND request_id>${afterItem})) ORDER BY session_id,request_id LIMIT 100`.pipe(
			Effect.orDie,
		);
		for (const row of rows) {
			const sessionId = SessionId.make(row.session_id),
				itemId = AgentItemId.make(row.request_id);
			yield* serialize(
				sessionId,
				itemId,
				Effect.gen(function* () {
					const delivery = yield* journal.read(sessionId, itemId);
					if (
						delivery?.status === "accepted" ||
						delivery?.status === "committed"
					) {
						yield* journal.commit(delivery);
						yield* provider.acknowledgePlanResponse?.(sessionId, itemId) ??
							Effect.void;
						return;
					}
					const owner =
						row.owner_json === null ? null : decodeOwner(row.owner_json);
					const owned =
						owner !== null && Result.isSuccess(owner)
							? ownsInputRequest(sql, sessionId, owner.success)
							: Effect.succeed(false);
					const uncertain = delivery?.status === "uncertain";
					if (!uncertain && (yield* owned.pipe(Effect.orDie))) return;
					const expired = yield* domain
						.dispatchTransactionally(
							{
								commandId: `plan:expire:${sessionId}:${itemId}`,
								streamId: sessionId,
								command: {
									_tag: "ExpirePlan",
									itemId,
									reason: uncertain ? "uncertain" : "expired",
									expiredAt: Date.now(),
								},
							},
							(receipt) =>
								Effect.gen(function* () {
									if (!uncertain && (yield* owned))
										return yield* new PlanStillOwned({});
									return receipt.eventIds.length > 0;
								}),
						)
						.pipe(
							Effect.catchTag(
								["PlanStillOwned", "SessionDeletedConflict", "SessionNotFound"],
								() => Effect.succeed(false),
							),
							Effect.orDie,
						);
					if (expired)
						yield* provider.acknowledgePlanResponse?.(sessionId, itemId) ??
							Effect.void;
				}),
			);
			afterSession = row.session_id;
			afterItem = row.request_id;
		}
		if (rows.length < 100) {
			afterSession = "";
			afterItem = "";
		}
	});
};
