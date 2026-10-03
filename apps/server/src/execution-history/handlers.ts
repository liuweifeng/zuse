import { MemoizeRpcs, SessionAttemptHistoryError } from "@zuse/contracts";
import { readSessionAttemptHistory } from "@zuse/domain/queries/sql-session-queries";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const ExecutionHistoryHandlersLayer = MemoizeRpcs.toLayerHandler(
	"session.attempts.list",
	({ sessionId, before }) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* readSessionAttemptHistory(sql, sessionId, before).pipe(
				Effect.mapError(
					() =>
						new SessionAttemptHistoryError({
							message: "Could not load execution history.",
						}),
				),
			);
		}),
);
