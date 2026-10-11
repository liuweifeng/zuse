import type { TaskResult } from "@zuse/agents/drivers/orchestration-tools";
import type { DelegationOrigin } from "@zuse/domain/agent-engine/delegation";
import { ownsInputRequest } from "@zuse/domain/agent-engine/input-owner";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Session ids are task ids; the existing lineage ledger owns task lifetime. */
export const makeOrchestrationTaskRuntime = (
	sql: SqlClient.SqlClient,
	domain: SessionDomainApi,
	cancelAutomation?: (sessionId: string) => Effect.Effect<void, unknown>,
) => {
	const listParents = Effect.fn("OrchestrationTask.listParents")(function* (
		projectId: string,
	) {
		const rows = yield* sql<{
			child_session_id: string;
			parent_session_id: string;
		}>`
            SELECT d.child_session_id, d.parent_session_id
            FROM session_delegations d
            JOIN sessions child ON child.id=d.child_session_id
            JOIN sessions parent ON parent.id=d.parent_session_id
            WHERE child.project_id=${projectId} AND parent.project_id=${projectId}`;
		return rows.map((row) => ({
			sessionId: row.child_session_id,
			parentSessionId: row.parent_session_id,
		}));
	});
	const owned = (parentSessionId: string, taskId: string) => sql<{
		child_session_id: string;
		cancelled_at: number | null;
		result_message_id: string | null;
		status: string | null;
		result: string | null;
		pending: number;
	}>`SELECT d.child_session_id,d.cancelled_at,d.result_message_id,t.status,l.context_text AS result,
 EXISTS(SELECT 1 FROM session_delegations child WHERE child.parent_session_id=d.child_session_id AND child.cancelled_at IS NULL AND (child.wake_turn_id IS NULL OR EXISTS(SELECT 1 FROM session_turns wake WHERE wake.id=child.wake_turn_id AND wake.status IN ('starting','running','finalizing')))) AS pending
 FROM session_delegations d LEFT JOIN session_turns t ON t.id=(SELECT latest.id FROM session_turns latest WHERE latest.session_id=d.child_session_id ORDER BY latest.ordinal DESC LIMIT 1) LEFT JOIN session_context_links l ON l.id='delegation:' || d.child_session_id
 WHERE d.parent_session_id=${parentSessionId} AND d.child_session_id=${taskId}`;
	const status = Effect.fn("OrchestrationTask.status")(function* (
		parentSessionId: string,
		taskId: string,
	): Effect.fn.Return<TaskResult, unknown> {
		const row = (yield* owned(parentSessionId, taskId))[0];
		if (!row)
			return { ok: false, error: "Task does not belong to this session." };
		return {
			ok: true,
			taskId,
			sessionId: taskId,
			status:
				row.cancelled_at !== null ? "cancelled" : (row.status ?? "deleted"),
			workState:
				row.cancelled_at !== null
					? "cancelled"
					: row.pending
						? "waiting_for_children"
						: row.result_message_id !== null
							? "result_available"
							: "working",
			...(row.result === null ? {} : { result: row.result }),
		};
	});
	const cancel = Effect.fn("OrchestrationTask.cancel")(function* (
		parentSessionId: string,
		taskId: string,
		origin?: DelegationOrigin,
	): Effect.fn.Return<TaskResult, unknown> {
		const cancellationId = crypto.randomUUID();
		yield* sql.withTransaction(
			Effect.gen(function* () {
				if (
					origin &&
					!(yield* ownsInputRequest(sql, parentSessionId, {
						providerSessionId: origin.providerSessionId,
						attempt: {
							turnId: origin.parentTurnId,
							attemptId: origin.parentAttemptId,
						},
					}))
				)
					return yield* Effect.fail({
						reason: "Parent execution no longer owns this cancellation.",
					});
				if ((yield* owned(parentSessionId, taskId)).length === 0)
					return yield* Effect.fail({
						reason: "Task does not belong to this session.",
					});
				const children = yield* sql<{
					id: string;
				}>`WITH RECURSIVE tree(id) AS (SELECT ${taskId} UNION SELECT d.child_session_id FROM session_delegations d JOIN tree ON d.parent_session_id=tree.id) SELECT id FROM tree`;
				for (const child of children) {
					if (cancelAutomation) yield* cancelAutomation(child.id);
					yield* sql`UPDATE session_delegations SET cancelled_at=COALESCE(cancelled_at,${Date.now()}) WHERE child_session_id=${child.id}`;
					const exists =
						yield* sql`SELECT 1 FROM sessions WHERE id=${child.id}`;
					if (exists.length === 0) continue;
					yield* domain.dispatch({
						streamId: child.id,
						commandId: `task-cancel:${cancellationId}:${child.id}:pause`,
						command: {
							_tag: "SetQueuePaused",
							paused: true,
							updatedAt: Date.now(),
						},
					});
					yield* domain.dispatch({
						streamId: child.id,
						commandId: `task-cancel:${cancellationId}:${child.id}:interrupt`,
						command: { _tag: "RequestTurnInterrupt", requestedAt: Date.now() },
					});
				}
			}),
		);
		return yield* status(parentSessionId, taskId);
	});
	const assertSendable = Effect.fn("OrchestrationTask.assertSendable")(
		function* (sessionId: string) {
			const rows =
				yield* sql`SELECT 1 FROM session_delegations WHERE child_session_id=${sessionId} AND cancelled_at IS NOT NULL`;
			if (rows.length)
				return yield* Effect.fail({
					reason:
						"This delegated task was cancelled. Create a new task for further work.",
				});
		},
	);
	return { status, cancel, assertSendable, listParents };
};
export type OrchestrationTaskRuntime = ReturnType<
	typeof makeOrchestrationTaskRuntime
>;
