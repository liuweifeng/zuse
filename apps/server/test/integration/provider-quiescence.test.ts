import { SessionId } from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { makeSqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { quiesceAndDetachProvider } from "../../src/conversation/core/provider-quiescence.ts";
import { makeProviderSessionRegistry } from "../../src/provider/provider-session-registry.ts";
import { quiesceProviderSession } from "../../src/provider/provider-stop.ts";
import { isEngineIdle } from "../../src/runtime-idle.ts";

it.each([
	"closed",
	"close-failed",
	"already-closed",
	"acquiring",
	"replacement",
] as const)("canonical checkpoint quiescence: %s", async (scenario) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				const sessionId = SessionId.make("session-1");
				for (const command of [
					createSessionCommand,
					{
						_tag: "ReserveProviderSession",
						providerId: "provider-1",
						providerSessionId: "old",
						reservedAt: 1,
					} as const,
					{
						_tag: "AttachProvider",
						providerId: "provider-1",
						providerSessionId: "old",
						attachedAt: 2,
					} as const,
				])
					yield* domain.dispatch({
						streamId: sessionId,
						commandId: crypto.randomUUID(),
						command,
					});
				let closed = 0;
				const handle = {
					close: () =>
						Effect.sync(() => {
							closed++;
							if (scenario === "close-failed") throw new Error("still alive");
						}),
				};
				const registry = makeProviderSessionRegistry<
					SessionId,
					{ providerSessionId: string; handle: typeof handle }
				>();
				if (scenario !== "already-closed") {
					const id = scenario === "replacement" ? "new" : "old";
					const generation = registry.begin(sessionId, id);
					if (scenario !== "acquiring")
						registry.publish(sessionId, generation, {
							providerSessionId: id,
							handle,
						});
				}
				const provider = {
					quiesce: (id: SessionId, expectedProviderSessionId?: string | null) =>
						quiesceProviderSession({
							registry,
							sessionId: id,
							expectedProviderSessionId,
							detachQuestions: Effect.void,
						}),
				};
				const result = yield* quiesceAndDetachProvider(
					domain,
					provider,
					sessionId,
				).pipe(Effect.result);
				const success = scenario === "closed" || scenario === "already-closed";
				expect(result._tag).toBe(success ? "Success" : "Failure");
				expect(yield* domain.providerReservation(sessionId)).toBe(
					success ? null : "old",
				);
				expect(closed).toBe(
					scenario === "closed" || scenario === "close-failed" ? 1 : 0,
				);
				expect(
					yield* isEngineIdle({
						sql,
						domain,
						activeTurnCount: makeSqlSessionQueries(sql).activeTurnCount,
						hasSession: () => Effect.succeed(false),
					}),
				).toBe(success);
				if (scenario === "close-failed" || scenario === "replacement")
					expect(registry.lookup(sessionId)).toBeDefined();
				if (scenario === "acquiring")
					expect(registry.currentProviderSessionId(sessionId)).toBe("old");
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
