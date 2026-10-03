import { AgentItemId, SessionId } from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { readSessionTimelineSnapshot } from "@zuse/domain/queries/session-timeline-snapshot";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { makePlanDelivery } from "../../src/conversation/core/plan-delivery.ts";
import { makePlanExpiry } from "../../src/conversation/core/plan-expiry.ts";
import { createPlanDeliveryJournal } from "../../src/persistence/migrations/0074_plan_deliveries.ts";

it.each([
	"live",
	"replaced",
	"restored",
	"uncertain",
	"legacy",
] as const)("projects %s plans consistently across expiry and snapshot", async (mode) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				yield* createPlanDeliveryJournal;
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				const sessionId = SessionId.make("session-1"),
					itemId = AgentItemId.make("plan:request");
				const dispatch = (
					command: Parameters<typeof domain.dispatch>[0]["command"],
				) =>
					domain.dispatch({
						streamId: sessionId,
						commandId: crypto.randomUUID(),
						command,
					});
				yield* dispatch(createSessionCommand);
				yield* sql`UPDATE sessions SET provider_reservation_id='provider-1' WHERE id=${sessionId}`;
				const request = {
					_tag: "PersistMessage" as const,
					messageId: "plan-message",
					turnId: null,
					role: "assistant" as const,
					kind: "tool_use",
					parentItemId: null,
					createdAt: 1,
					contentJson: JSON.stringify({
						_tag: "tool_use",
						itemId,
						tool: "ExitPlanMode",
						input: { plan: "Implement recovery" },
					}),
					...(mode === "legacy"
						? {}
						: { inputOwner: { providerSessionId: "provider-1" } }),
				};
				yield* dispatch(request);
				if (mode === "replaced" || mode === "restored")
					yield* sql`UPDATE sessions SET provider_reservation_id='provider-2' WHERE id=${sessionId}`;
				const journal = makePlanDelivery(sql, {
					persistMessage: () => Effect.die("unexpected receipt"),
					ndjsonAppend: () => Effect.void,
				});
				if (mode === "uncertain") {
					yield* journal.begin(
						sessionId,
						itemId,
						null,
						{ providerSessionId: "provider-1" },
						{ outcome: "approved" },
					);
					yield* journal.recover;
				}
				let acknowledgements = 0;
				const expiryDomain =
					mode === "restored"
						? {
								...domain,
								dispatchTransactionally: ((
									...args: Parameters<typeof domain.dispatchTransactionally>
								) =>
									Effect.gen(function* () {
										yield* sql`UPDATE sessions SET provider_reservation_id='provider-1' WHERE id=${sessionId}`.pipe(
											Effect.orDie,
										);
										return yield* domain.dispatchTransactionally(...args);
									})) as typeof domain.dispatchTransactionally,
							}
						: domain;
				const sweep = makePlanExpiry(
					sql,
					expiryDomain,
					{
						acknowledgePlanResponse: () =>
							Effect.sync(() => {
								acknowledgements++;
							}),
					},
					journal,
					(_s, _i, work) => work,
				);
				yield* sweep;
				yield* sweep;
				// Duplicate/replayed requests cannot reopen a terminal input.
				yield* dispatch(request);
				const snapshot = yield* readSessionTimelineSnapshot(sql, sessionId);
				expect(snapshot.projection.interactions).toEqual([
					{
						_tag: "Plan",
						id: itemId,
						requestedAt: new Date(1),
						...(mode === "live" || mode === "restored"
							? {}
							: {
									recoveryState: mode === "uncertain" ? "uncertain" : "expired",
								}),
					},
				]);
				const events =
					yield* sql`SELECT sequence FROM events WHERE type='PlanExpired'`;
				expect(acknowledgements).toBe(
					mode === "live" || mode === "restored" ? 0 : 1,
				);
				expect(events).toHaveLength(
					mode === "live" || mode === "restored" ? 0 : 1,
				);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
