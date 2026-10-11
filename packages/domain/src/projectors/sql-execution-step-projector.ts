import { MessageContent, type SessionExecutionStep } from "@zuse/contracts";
import { Effect, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { StoredEvent } from "../engine/dispatch.js";
import { evolveExecutionStep, executionStepItem } from "./execution-steps.js";

const decode = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);
/** A derived execution tree, committed with the canonical message that owns it. */
export const projectExecutionStep = (
	sql: SqlClient.SqlClient,
	record: StoredEvent,
	attemptOverride?: string,
) =>
	Effect.gen(function* () {
		const event = record.event;
		if (event._tag === "AttemptStarted") {
			yield* sql`UPDATE session_execution_steps SET status='cancelled',updated_at=${event.startedAt} WHERE session_id=${record.streamId} AND turn_id=${event.turnId} AND attempt_id<>${event.attemptId} AND status='running'`;
			return;
		}
		if (event._tag === "TurnsRolledBack") {
			yield* sql`UPDATE session_execution_steps SET status='cancelled',updated_at=${event.rolledBackAt} WHERE session_id=${record.streamId} AND turn_id IN (SELECT id FROM session_turns WHERE session_id=${record.streamId} AND ordinal>${event.throughOrdinal})`;
			return;
		}
		if (event._tag === "TurnSettled") {
			yield* sql`UPDATE session_execution_steps SET status=${event.outcome === "error" ? "failed" : "cancelled"},updated_at=${event.settledAt} WHERE session_id=${record.streamId} AND turn_id=${event.turnId} AND status='running'`;
			return;
		}
		if (event._tag === "SessionDeleted") {
			yield* sql`DELETE FROM session_execution_steps WHERE session_id=${record.streamId}`;
			return;
		}
		if (event._tag !== "MessagePersisted" || event.turnId === null) return;
		if (
			![
				"tool_use",
				"tool_result",
				"subagent_summary",
				"subagent_progress",
			].includes(event.kind)
		)
			return;
		const accepted =
			yield* sql`SELECT 1 FROM messages WHERE id=${event.messageId} AND session_id=${record.streamId} AND content_json=${event.contentJson}`;
		if (accepted.length === 0) return;
		const parsed = decode(event.contentJson);
		if (Result.isFailure(parsed)) return;
		const content = parsed.success;
		const rows = yield* sql<{
			active_attempt_id: string | null;
		}>`SELECT active_attempt_id FROM session_turns WHERE session_id=${record.streamId} AND id=${event.turnId}`;
		const attemptId = attemptOverride ?? rows[0]?.active_attempt_id;
		if (attemptId === null || attemptId === undefined) return;

		const item = executionStepItem(content);
		if (item === null && content._tag !== "subagent_progress") return;
		const previousRows =
			yield* sql<SessionExecutionStep>`SELECT id,turn_id AS turnId,attempt_id AS attemptId,item_id AS itemId,parent_item_id AS parentItemId,kind,label,status,child_session_id AS childSessionId,native_child_id AS nativeChildId,root_completed_at AS rootCompletedAt,created_at AS createdAt,updated_at AS updatedAt,'unsupported' AS checkpointCapability FROM session_execution_steps WHERE session_id=${record.streamId} AND turn_id=${event.turnId} AND attempt_id=${attemptId} AND (${item !== null} AND item_id=${item} OR ${item === null} AND native_child_id=${content._tag === "subagent_progress" ? content.childSessionId : null}) LIMIT 1`;
		const previous = previousRows[0] ?? null;
		const next = evolveExecutionStep(
			previous,
			{
				sessionId: record.streamId,
				turnId: event.turnId,
				attemptId,
				at: event.createdAt,
			},
			content,
		);
		if (next === null || next === previous) return;
		yield* sql`INSERT INTO session_execution_steps(id,session_id,turn_id,attempt_id,item_id,parent_item_id,kind,label,status,child_session_id,native_child_id,root_completed_at,created_at,updated_at) VALUES(${next.id},${record.streamId},${next.turnId},${next.attemptId},${next.itemId},${next.parentItemId},${next.kind},${next.label},${next.status},${next.childSessionId},${next.nativeChildId},${next.rootCompletedAt},${next.createdAt},${next.updatedAt}) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,child_session_id=excluded.child_session_id,native_child_id=excluded.native_child_id,status=excluded.status,root_completed_at=excluded.root_completed_at,updated_at=excluded.updated_at`;
	});
