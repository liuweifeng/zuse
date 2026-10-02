import type { SessionEvent } from "@zuse/domain/core/events";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Migration0067ProviderReservations } from "../../src/persistence/migrations/0067_provider_reservations.ts";

it("reconstructs only surviving reservations and can run again", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE events (stream_id TEXT, stream_kind TEXT, stream_version INTEGER, type TEXT, payload_json TEXT)`;
			const reserve = (id: string): SessionEvent => ({
				_tag: "ProviderSessionReserved",
				providerId: "claude",
				providerSessionId: id,
				reservedAt: 1,
			});
			const scenarios: ReadonlyArray<
				readonly [string, ReadonlyArray<SessionEvent>, string | null]
			> = [
				["legacy", [], null],
				["starting", [reserve("pending")], "pending"],
				[
					"stopped",
					[
						reserve("stopped"),
						{
							_tag: "ProviderStopRequested",
							providerId: "claude",
							providerSessionId: "stopped",
							requestedAt: 2,
						},
					],
					null,
				],
				[
					"replacement",
					[
						reserve("old"),
						reserve("new"),
						{
							_tag: "ProviderDetached",
							providerId: "claude",
							providerSessionId: "old",
							detachedAt: 2,
						},
					],
					"new",
				],
				[
					"archived",
					[
						reserve("archived"),
						{ _tag: "SessionArchived", archivedAt: 2 },
						{ _tag: "SessionUnarchived", unarchivedAt: 3 },
					],
					null,
				],
				[
					"model",
					[
						reserve("model"),
						{ _tag: "SessionModelSet", model: "new", updatedAt: 2 },
					],
					null,
				],
			];
			for (const [id, events] of scenarios) {
				yield* sql`INSERT INTO sessions (id) VALUES (${id})`;
				for (const [version, event] of events.entries()) {
					yield* sql`INSERT INTO events VALUES (${id}, 'session', ${version}, ${event._tag}, ${JSON.stringify(event)})`;
				}
			}
			for (let pass = 0; pass < 2; pass++) {
				yield* Migration0067ProviderReservations;
				for (const [id, , expected] of scenarios) {
					const rows = yield* sql<{
						provider_reservation_id: string | null;
					}>`SELECT provider_reservation_id FROM sessions WHERE id = ${id}`;
					expect(rows[0]?.provider_reservation_id).toBe(expected);
				}
			}
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
