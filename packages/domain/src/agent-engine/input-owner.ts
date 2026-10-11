import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Captured when a provider publishes an input; historical unknown ownership stays unknown. */
export const InputRequestOwner = Schema.Struct({
	providerSessionId: Schema.String,
	attempt: Schema.optional(
		Schema.Struct({ turnId: Schema.String, attemptId: Schema.String }),
	),
});
export type InputRequestOwner = typeof InputRequestOwner.Type;

/** Durable authority shared by approvals and question delivery. */
export const ownsInputRequest = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	owner: InputRequestOwner,
) =>
	Effect.gen(function* () {
		const rows = yield* sql`SELECT 1 FROM sessions s WHERE s.id = ${sessionId}
			AND s.archived_at IS NULL AND s.provider_reservation_id = ${owner.providerSessionId}
			AND (${owner.attempt === undefined} OR EXISTS (
				SELECT 1 FROM session_turns t WHERE t.session_id = s.id
				AND t.id = ${owner.attempt?.turnId ?? null}
				AND t.active_attempt_id = ${owner.attempt?.attemptId ?? null}
				AND t.status IN ('starting', 'running') AND t.phase = 'running'
			))`;
		return rows.length === 1;
	});
