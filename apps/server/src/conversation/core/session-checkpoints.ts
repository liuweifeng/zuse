import {
	type AgentTurnId,
	type NativeHistoryCheckpoint,
	type Session,
	SessionCheckpointError,
} from "@zuse/contracts";
import { derive } from "@zuse/domain/agent-engine/ids";
import { captureGitCheckpoint } from "@zuse/git/checkpoints";
import type { GitServiceShape } from "@zuse/git/git-service";
import { Context, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export const CheckpointFiles = Context.Reference<{
	readonly capture: (
		cwd: string,
		id: string,
	) => Promise<{ readonly commit: string }>;
}>("zuse/conversation/CheckpointFiles", {
	defaultValue: () => ({ capture: captureGitCheckpoint }),
});

export const makeSessionCheckpoints = (
	sql: SqlClient.SqlClient,
	git: Pick<GitServiceShape, "isRepository">,
	files: typeof CheckpointFiles.Service,
	captureHistory?: (
		sessionId: Session["id"],
	) => Effect.Effect<NativeHistoryCheckpoint | null, Error>,
) => {
	const capture = (
		session: Session,
		turnId: AgentTurnId,
		attemptId: string,
		phase: "baseline" | "final",
		outcome?: "completed" | "interrupted" | "error",
	) =>
		Effect.gen(function* () {
			// A retry is another attempt of the same counted turn, not a new baseline.
			const id =
				phase === "baseline"
					? `checkpoint:${session.id}:${turnId}:baseline`
					: `checkpoint:${session.id}:${turnId}:${attemptId}:final`;
			const existing = yield* sql<{
				status: string;
				cwd: string;
			}>`SELECT status,cwd FROM session_checkpoints WHERE id=${id}`;
			if (
				existing[0]?.status === "ready" ||
				existing[0]?.status === "unsupported"
			)
				return;
			const rows = yield* sql<{
				cwd: string | null;
			}>`SELECT CASE WHEN s.worktree_id IS NULL THEN p.path ELSE w.path END AS cwd FROM sessions s JOIN projects p ON p.id=s.project_id LEFT JOIN worktrees w ON w.id=s.worktree_id WHERE s.id=${session.id}`;
			const cwd = existing[0]?.cwd ?? rows[0]?.cwd;
			if (cwd == null)
				return yield* new SessionCheckpointError({
					message: "Checkpoint checkout is unavailable.",
				});
			const turns = yield* sql<{
				attempt_ordinal: number;
			}>`SELECT attempt_ordinal FROM session_turns WHERE session_id=${session.id} AND id=${turnId}`;
			const rootStepId = derive.rootStep({
				turnId,
				attemptOrdinal: turns[0]?.attempt_ordinal ?? 1,
			});
			const cutoff =
				phase === "baseline"
					? yield* sql<{
							sequence: number;
						}>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM messages WHERE session_id=${session.id} AND (turn_id IS NULL OR turn_id<>${turnId})`
					: yield* sql<{
							sequence: number;
						}>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM messages WHERE session_id=${session.id}`;
			yield* sql`INSERT INTO session_checkpoints(id,session_id,turn_id,attempt_id,scope_id,root_step_id,phase,cwd,project_id,worktree_id,status,message_sequence,outcome,created_at)
   VALUES(${id},${session.id},${turnId},${attemptId},${derive.checkpointScope({ sessionId: session.id, name: turnId })},${rootStepId},${phase},${cwd},${session.projectId},${session.worktreeId},'capturing',${cutoff[0]?.sequence ?? 0},${outcome ?? null},${Date.now()})
   ON CONFLICT(id) DO UPDATE SET status='capturing',error=NULL`;
			const repository = yield* git.isRepository(session.projectId).pipe(
				Effect.mapError(
					() =>
						new SessionCheckpointError({
							message: "Could not inspect checkpoint repository.",
						}),
				),
			);
			if (!repository) {
				yield* sql`UPDATE session_checkpoints SET status='unsupported',captured_at=${Date.now()} WHERE id=${id}`;
				return;
			}
			const snapshot = yield* Effect.tryPromise({
				try: () => files.capture(cwd, id),
				catch: () =>
					new SessionCheckpointError({
						message:
							"Could not capture checkout state. Resolve Git conflicts or unavailable files, then retry finalization.",
					}),
			}).pipe(
				Effect.tapError((error) =>
					sql`UPDATE session_checkpoints SET status='error',error=${error.message} WHERE id=${id}`.pipe(
						Effect.orDie,
					),
				),
			);
			const nativeHistory =
				phase === "final" &&
				outcome === "completed" &&
				captureHistory !== undefined
					? yield* captureHistory(session.id).pipe(
							Effect.catch(() => Effect.succeed(null)),
						)
					: null;
			yield* sql`UPDATE session_checkpoints SET status='ready',commit_id=${snapshot.commit},native_history_json=${nativeHistory === null ? null : JSON.stringify(nativeHistory)},captured_at=${Date.now()},error=NULL WHERE id=${id}`;
		}).pipe(
			Effect.catchTag("SqlError", () =>
				Effect.fail(
					new SessionCheckpointError({
						message: "Could not persist the checkpoint.",
					}),
				),
			),
		);
	return { capture };
};
