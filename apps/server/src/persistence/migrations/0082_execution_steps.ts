import { attemptIdFor } from "@zuse/domain/core/state";
import { projectExecutionStep } from "@zuse/domain/projectors/sql-execution-step-projector";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0082ExecutionSteps = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE session_execution_steps (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 item_id TEXT NOT NULL,parent_item_id TEXT,kind TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,
 child_session_id TEXT,native_child_id TEXT,root_completed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(session_id,turn_id,attempt_id,item_id)
 )`;
	yield* sql`CREATE INDEX session_execution_steps_turn ON session_execution_steps(session_id,turn_id,created_at,id)`;
	yield* sql`CREATE INDEX session_execution_steps_active ON session_execution_steps(session_id,status) WHERE status='running'`;
	// Existing canonical messages are paged; attempt ownership is reconstructed at
	// each message's original event sequence, never guessed from the newest retry.
	let after = 0;
	while (true) {
		const page = yield* sql<{
			id: string;
			session_id: string;
			turn_id: string;
			role: string;
			kind: string;
			content_json: string;
			parent_item_id: string | null;
			created_at: string;
			sequence: number;
		}>`SELECT id,session_id,turn_id,role,kind,content_json,parent_item_id,created_at,sequence FROM messages WHERE sequence>${after} AND turn_id IS NOT NULL AND kind IN ('tool_use','tool_result','subagent_summary','subagent_progress') ORDER BY sequence LIMIT 250`;
		if (page.length === 0) break;
		for (const row of page) {
			const owner = yield* sql<{
				attempt_id: string | null;
			}>`SELECT json_extract(payload_json,'$.attemptId') AS attempt_id FROM events WHERE stream_kind='session' AND stream_id=${row.session_id} AND sequence<=${row.sequence} AND type IN ('TurnStarted','AttemptStarted') AND json_extract(payload_json,'$.turnId')=${row.turn_id} ORDER BY sequence DESC LIMIT 1`;
			const attemptId = owner[0]?.attempt_id ?? attemptIdFor(row.turn_id, 1);
			yield* projectExecutionStep(
				sql,
				{
					eventId: `migration:${row.id}`,
					correlationId: "migration:execution-steps",
					causationEventId: null,
					streamId: row.session_id,
					streamVersion: 0,
					sequence: row.sequence,
					event: {
						_tag: "MessagePersisted",
						messageId: row.id,
						turnId: row.turn_id,
						role: row.role,
						kind: row.kind,
						contentJson: row.content_json,
						parentItemId: row.parent_item_id,
						createdAt: Date.parse(row.created_at),
					},
				},
				attemptId,
			);
			after = row.sequence;
		}
	}
	// Historical open steps are not evidence of live processes after upgrade.
	yield* sql`UPDATE session_execution_steps SET status='cancelled' WHERE status='running' AND NOT EXISTS(SELECT 1 FROM session_turns t WHERE t.session_id=session_execution_steps.session_id AND t.id=session_execution_steps.turn_id AND t.active_attempt_id=session_execution_steps.attempt_id AND t.status IN ('starting','running'))`;
});
