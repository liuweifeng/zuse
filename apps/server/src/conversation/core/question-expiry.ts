import { AgentItemId, SessionId } from "@zuse/contracts";
import {
	InputRequestOwner,
	ownsInputRequest,
} from "@zuse/domain/agent-engine/input-owner";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";

class QuestionStillOwned extends Schema.TaggedErrorClass<QuestionStillOwned>()(
	"QuestionStillOwned",
	{},
) {}
const decodeOwner = Schema.decodeUnknownResult(
	Schema.fromJsonString(InputRequestOwner),
);

/** Bounded keyset traversal prevents a page of live questions starving older detached inputs. */
export const makeQuestionExpiry = (
	sql: SqlClient.SqlClient,
	domain: SessionDomainApi,
	provider: Pick<
		ProviderServiceShape,
		| "hasQuestionAttachment"
		| "cancelQuestion"
		| "acknowledgeQuestionResolution"
		| "close"
	>,
) => {
	let afterSession = "";
	let afterRequest = "";
	return Effect.gen(function* () {
		const rows = yield* sql<{
			session_id: string;
			request_id: string;
			owner_json: string | null;
		}>`
			SELECT session_id, request_id, owner_json FROM session_inputs
			WHERE kind = 'question' AND status = 'pending' AND request_json IS NOT NULL
				AND (session_id > ${afterSession} OR (session_id = ${afterSession} AND request_id > ${afterRequest}))
			ORDER BY session_id, request_id LIMIT 100
		`.pipe(Effect.orDie);
		for (const row of rows) {
			afterSession = row.session_id;
			afterRequest = row.request_id;
			const sessionId = SessionId.make(row.session_id);
			const itemId = AgentItemId.make(row.request_id);
			const decoded =
				row.owner_json === null ? null : decodeOwner(row.owner_json);
			const owner =
				decoded !== null && Result.isSuccess(decoded)
					? decoded.success
					: undefined;
			const alive =
				owner === undefined
					? Effect.succeed(false)
					: ownsInputRequest(sql, sessionId, owner).pipe(
							Effect.flatMap((owned) =>
								owned
									? provider.hasQuestionAttachment(sessionId, itemId)
									: Effect.succeed(false),
							),
						);
			if (yield* alive.pipe(Effect.orDie)) continue;
			const expired = yield* domain
				.dispatchTransactionally(
					{
						commandId: `question:expire:${sessionId}:${itemId}`,
						streamId: sessionId,
						command: { _tag: "ExpireQuestion", itemId, expiredAt: Date.now() },
					},
					(receipt) =>
						Effect.gen(function* () {
							if (yield* alive) return yield* new QuestionStillOwned({});
							return receipt.eventIds.length > 0;
						}),
				)
				.pipe(
					Effect.catchTag(
						["QuestionStillOwned", "SessionDeletedConflict", "SessionNotFound"],
						() => Effect.succeed(false),
					),
					Effect.orDie,
				);
			if (!expired) continue;
			if (yield* provider.hasQuestionAttachment(sessionId, itemId)) {
				const close = provider
					.close(sessionId, undefined, owner?.providerSessionId ?? null)
					.pipe(Effect.catch(() => Effect.void));
				yield* provider.cancelQuestion(sessionId, itemId).pipe(
					Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => close }),
					Effect.catch(() => close),
				);
			}
			yield* provider.acknowledgeQuestionResolution(sessionId, itemId);
		}
		if (rows.length < 100) {
			afterSession = "";
			afterRequest = "";
		}
	});
};
