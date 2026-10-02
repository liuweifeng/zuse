import { MessageContent } from "@zuse/contracts";
import { Effect, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { InputRequestOwner } from "../agent-engine/input-owner.js";
import type { StoredEvent } from "../engine/dispatch.js";

/** Shared DDL keeps migration and isolated domain databases on the same schema. */
export const createSessionInputProjection = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		yield* sql`CREATE TABLE IF NOT EXISTS session_inputs (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			kind TEXT NOT NULL CHECK (kind IN ('question', 'permission')),
			request_id TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'expired')),
			request_json TEXT,
			owner_json TEXT,
			turn_id TEXT,
			requested_at TEXT,
			requested_sequence INTEGER,
			updated_sequence INTEGER NOT NULL,
			PRIMARY KEY (session_id, kind, request_id)
		)`;
		yield* sql`CREATE INDEX IF NOT EXISTS session_inputs_pending
			ON session_inputs(session_id, kind, status, requested_sequence)`;
	});

const decodeContent = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);

type InputEvent = Pick<StoredEvent, "streamId" | "sequence" | "event">;

/** A read model of durable requests, never a second callback/answer authority. */
export const projectSessionInput = (
	sql: SqlClient.SqlClient,
	record: InputEvent,
) =>
	Effect.gen(function* () {
		const { event, streamId, sequence } = record;
		const request = (
			kind: "question" | "permission",
			id: string,
			json: string,
			at: number,
			turnId: string | null,
			owner?: InputRequestOwner,
		) => {
			const requestedAt = new Date(at);
			if (Number.isNaN(requestedAt.getTime())) return Effect.void;
			return sql`
			INSERT INTO session_inputs
				(session_id, kind, request_id, status, request_json, requested_at,
				 requested_sequence, updated_sequence, owner_json, turn_id)
			VALUES (${streamId}, ${kind}, ${id}, 'pending', ${json},
				${requestedAt.toISOString()}, ${sequence}, ${sequence},
				${owner === undefined ? null : JSON.stringify(owner)}, ${turnId})
			ON CONFLICT(session_id, kind, request_id) DO UPDATE SET
				request_json = excluded.request_json,
				owner_json = CASE WHEN session_inputs.requested_sequence > excluded.requested_sequence
					THEN excluded.owner_json ELSE COALESCE(session_inputs.owner_json, excluded.owner_json) END,
				turn_id = excluded.turn_id,
				requested_at = excluded.requested_at,
				requested_sequence = excluded.requested_sequence,
				updated_sequence = MAX(session_inputs.updated_sequence, excluded.updated_sequence)
			WHERE session_inputs.requested_sequence IS NULL
				OR session_inputs.requested_sequence >= excluded.requested_sequence
		`;
		};
		const resolve = (
			kind: "question" | "permission",
			id: string,
			status: "answered" | "cancelled" | "expired",
		) => sql`
			INSERT INTO session_inputs
				(session_id, kind, request_id, status, updated_sequence)
			VALUES (${streamId}, ${kind}, ${id}, ${status}, ${sequence})
			ON CONFLICT(session_id, kind, request_id) DO UPDATE SET
				status = excluded.status,
				updated_sequence = MAX(session_inputs.updated_sequence, excluded.updated_sequence)
			WHERE session_inputs.status = 'pending'
				OR (session_inputs.status = 'expired' AND session_inputs.updated_sequence < excluded.updated_sequence)
		`;
		switch (event._tag) {
			case "SessionDeleted":
				yield* sql`DELETE FROM session_inputs WHERE session_id = ${streamId}`;
				return;
			case "PermissionRequested":
				yield* request(
					"permission",
					event.requestId,
					event.payloadJson,
					event.requestedAt,
					event.inputOwner === undefined
						? event.turnId
						: (event.inputOwner.attempt?.turnId ?? null),
					event.inputOwner,
				);
				return;
			case "PermissionExpired":
				yield* resolve("permission", event.requestId, "expired");
				return;
			case "PermissionResolved":
				yield* resolve("permission", event.requestId, "answered");
				return;
			case "QuestionResolved":
				yield* resolve("question", event.itemId, "cancelled");
				return;
			case "MessagePersisted": {
				if (
					event.kind !== "user_question" &&
					event.kind !== "user_question_answer"
				)
					return;
				const decoded = decodeContent(event.contentJson);
				if (Result.isFailure(decoded)) return;
				const content = decoded.success;
				if (content._tag === "user_question") {
					yield* request(
						"question",
						content.itemId,
						event.contentJson,
						event.createdAt,
						event.turnId,
						event.inputOwner,
					);
				} else if (content._tag === "user_question_answer") {
					yield* resolve(
						"question",
						content.itemId,
						content.resolution === "timed-out"
							? "expired"
							: content.resolution === "cancelled"
								? "cancelled"
								: "answered",
					);
				}
				return;
			}
			default:
				return;
		}
	});

/** Read the accepted message after checkpoint conflict handling, shared with backfill. */
export const projectCommittedMessageInput = (
	sql: SqlClient.SqlClient,
	record: InputEvent,
) =>
	Effect.gen(function* () {
		const event = record.event;
		if (
			event._tag !== "MessagePersisted" ||
			(event.kind !== "user_question" && event.kind !== "user_question_answer")
		)
			return;
		const rows = yield* sql<{
			content_json: string;
			kind: string;
			created_at: string;
			sequence: number;
		}>`
			SELECT content_json, kind, created_at, COALESCE(sequence, 0) AS sequence FROM messages
			WHERE id = ${event.messageId} AND session_id = ${record.streamId}
		`;
		const row = rows[0];
		if (row === undefined) return;
		yield* projectSessionInput(sql, {
			...record,
			sequence: row.sequence,
			event: {
				...event,
				contentJson: row.content_json,
				kind: row.kind,
				createdAt: new Date(row.created_at).getTime(),
			},
		});
	});
