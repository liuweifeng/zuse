import { type ProviderId, SessionStartError } from "@zuse/contracts";
import type { DelegationOrigin } from "@zuse/domain/agent-engine/delegation";
import { ownsInputRequest } from "@zuse/domain/agent-engine/input-owner";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Runs inside child creation's transaction, after its projection but before admission commits. */
export const validateDelegationOrigin = (
	sql: SqlClient.SqlClient,
	origin: DelegationOrigin,
	childSessionId: string,
	providerId: ProviderId,
) =>
	Effect.gen(function* () {
		const valid = yield* ownsInputRequest(sql, origin.parentSessionId, {
			providerSessionId: origin.providerSessionId,
			attempt: {
				turnId: origin.parentTurnId,
				attemptId: origin.parentAttemptId,
			},
		});
		if (!valid)
			return yield* new SessionStartError({
				providerId,
				reason: "The parent execution no longer owns this delegation.",
			});
		const siblings = yield* sql<{
			count: number;
		}>`SELECT COUNT(*) AS count FROM session_delegations WHERE parent_session_id=${origin.parentSessionId} AND parent_turn_id=${origin.parentTurnId} AND parent_attempt_id=${origin.parentAttemptId}`;
		const ancestry = yield* sql<{
			depth: number;
		}>`WITH RECURSIVE ancestors(session_id,depth) AS (
  SELECT ${origin.parentSessionId},1 UNION ALL
  SELECT d.parent_session_id,a.depth+1 FROM session_delegations d JOIN ancestors a ON d.child_session_id=a.session_id WHERE a.depth<5
 ) SELECT MAX(depth) AS depth FROM ancestors`;
		if ((siblings[0]?.count ?? 0) > 8 || (ancestry[0]?.depth ?? 0) > 4)
			return yield* new SessionStartError({
				providerId,
				reason:
					"Delegation is limited to eight children per turn and four nested levels.",
			});
		const budget = yield* sql<{
			count: number;
		}>`WITH RECURSIVE ancestors(session_id,depth) AS (
          SELECT ${origin.parentSessionId},0 UNION ALL
          SELECT d.parent_session_id,a.depth+1 FROM session_delegations d JOIN ancestors a ON d.child_session_id=a.session_id WHERE a.depth<5
        ), root AS (SELECT session_id FROM ancestors ORDER BY depth DESC LIMIT 1), descendants(session_id) AS (
          SELECT session_id FROM root UNION SELECT d.child_session_id FROM session_delegations d JOIN descendants a ON d.parent_session_id=a.session_id
        ) SELECT COUNT(*)-1 AS count FROM descendants`;
		if ((budget[0]?.count ?? 0) > 32)
			return yield* new SessionStartError({
				providerId,
				reason: "A delegated task tree is limited to 32 child sessions.",
			});
		const project =
			yield* sql`SELECT 1 FROM sessions parent JOIN sessions child ON child.project_id=parent.project_id WHERE parent.id=${origin.parentSessionId} AND child.id=${childSessionId}`;
		if (project.length !== 1)
			return yield* new SessionStartError({
				providerId,
				reason: "Delegated work must remain in the parent's project.",
			});
	});
