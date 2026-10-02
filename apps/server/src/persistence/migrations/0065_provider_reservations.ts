import { SessionEvent } from "@zuse/domain/core/events";
import { evolve, initialSessionState } from "@zuse/domain/core/state";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Rebuild the current reservation pointer from lifecycle history, not a live process. */
export const Migration0065ProviderReservations = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql<{
		readonly name: string;
	}>`PRAGMA table_info(sessions)`;
	if (!columns.some((column) => column.name === "provider_reservation_id")) {
		yield* sql`ALTER TABLE sessions ADD COLUMN provider_reservation_id TEXT`;
	}
	const sessions = yield* sql<{ readonly id: string }>`
 SELECT DISTINCT s.id FROM sessions s JOIN events e ON e.stream_id = s.id
 WHERE e.stream_kind = 'session' AND e.type = 'ProviderSessionReserved'
 `;
	for (const session of sessions) {
		const rows = yield* sql<{
			readonly type: string;
			readonly payload_json: string;
		}>`
   SELECT type, payload_json FROM events WHERE stream_kind = 'session' AND stream_id = ${session.id}
   AND type IN ('SessionCreated', 'SessionModelSet', 'SessionProviderSet', 'SessionWorktreeSet',
    'SessionArchived', 'SessionUnarchived', 'SessionDeleted', 'ProviderSessionReserved',
    'ProviderAttached', 'ProviderStopRequested', 'ProviderDetached') ORDER BY stream_version
  `;
		let state = initialSessionState;
		for (const row of rows) {
			const payload = yield* Effect.try(() => JSON.parse(row.payload_json));
			const event = yield* Schema.decodeUnknownEffect(SessionEvent)({
				...payload,
				_tag: row.type,
			});
			state = evolve(state, event);
		}
		yield* sql`UPDATE sessions SET provider_reservation_id = ${state.providerReservation?.providerSessionId ?? null} WHERE id = ${session.id}`;
	}
});
