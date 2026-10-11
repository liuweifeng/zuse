import type { SessionId, ThreadGoal } from "@zuse/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { GoalResidency } from "../../provider/provider-goal.ts";

export const isCurrentGoalResidency = (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
	residency: GoalResidency,
) =>
	sql`SELECT id FROM sessions WHERE id=${sessionId} AND provider_reservation_id=${residency.providerSessionId} AND provider_id=${residency.providerId} AND archived_at IS NULL`.pipe(
		Effect.map((rows) => rows.length > 0),
		Effect.orDie,
	);

/** Canonical switches revoke publication before their asynchronous stop job retires the process. */
export const makeCurrentGoalPublisher =
	(
		sql: SqlClient.SqlClient,
		publish: (
			sessionId: SessionId,
			goal: ThreadGoal | null,
		) => Effect.Effect<void>,
	) =>
	(sessionId: SessionId, residency: GoalResidency, goal: ThreadGoal | null) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					if (!(yield* isCurrentGoalResidency(sql, sessionId, residency)))
						return false;
					yield* publish(sessionId, goal);
					return true;
				}),
			)
			.pipe(Effect.orDie);
