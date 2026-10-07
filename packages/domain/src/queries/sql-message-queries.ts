import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { MessageReadRecord } from "../projectors/read-model.js";

export class SessionQueryDecodeError extends Schema.TaggedErrorClass<SessionQueryDecodeError>()(
	"SessionQueryDecodeError",
	{
		recordKind: Schema.Literals(["session", "message", "attempt"]),
		reason: Schema.String,
	},
) {}

export interface MessageRow {
	readonly id: string;
	readonly session_id: string;
	readonly turn_id: string | null;
	readonly role: string;
	readonly kind: string;
	readonly content_json: string;
	readonly parent_item_id: string | null;
	readonly created_at: string;
	readonly sequence: number;
	readonly checkpoint_revision: number | null;
	readonly checkpoint_final: number | null;
}

export const MESSAGE_ROW_COLUMNS =
	"id, session_id, turn_id, role, kind, content_json, parent_item_id, created_at, sequence, checkpoint_revision, checkpoint_final";

export const messageRecord = Effect.fn("SqlSessionQueries.messageRecord")(
	function* (row: MessageRow) {
		const createdAt = Date.parse(row.created_at);
		if (!Number.isFinite(createdAt))
			return yield* new SessionQueryDecodeError({
				recordKind: "message",
				reason: `invalid timestamp: ${row.created_at}`,
			});
		return {
			messageId: row.id,
			sessionId: row.session_id,
			turnId: row.turn_id,
			role: row.role,
			kind: row.kind,
			contentJson: row.content_json,
			parentItemId: row.parent_item_id,
			createdAt,
			sequence: row.sequence,
			checkpointRevision: row.checkpoint_revision,
			checkpointFinal:
				row.checkpoint_final === null ? null : row.checkpoint_final === 1,
		} satisfies MessageReadRecord;
	},
);

export interface MessageListInput {
	readonly sessionId: string;
	readonly order?: "sequence" | "createdAt";
	readonly direction?: "asc" | "desc";
	readonly limit?: number;
	readonly kinds?: readonly string[];
	readonly role?: string;
	readonly afterSequence?: number;
	readonly throughSequence?: number;
	readonly turnId?: string;
	readonly excludedTurnId?: string;
	readonly excludeIdPrefix?: string;
	readonly excludePendingContextLinks?: boolean;
}

/** SQL projections are read here; callers keep their transactional business rules. */
export const makeSqlMessageQueries = (sql: SqlClient.SqlClient) => {
	const messageList = Effect.fn("SqlSessionQueries.messageList")(function* (
		input: MessageListInput,
	) {
		const filters = ["session_id = ?"];
		const values: Array<string | number | null> = [input.sessionId];
		const where = (
			clause: string,
			...parameters: Array<string | number | null>
		) => {
			filters.push(clause);
			values.push(...parameters);
		};
		if (input.role !== undefined) where("role = ?", input.role);
		if (input.kinds !== undefined) {
			if (input.kinds.length === 0) return [];
			where(
				`kind IN (${input.kinds.map(() => "?").join(",")})`,
				...input.kinds,
			);
		}
		if (input.afterSequence !== undefined)
			where("sequence > ?", input.afterSequence);
		if (input.throughSequence !== undefined)
			where("sequence <= ?", input.throughSequence);
		if (input.turnId !== undefined) where("turn_id = ?", input.turnId);
		if (input.excludedTurnId !== undefined)
			where("(turn_id IS NULL OR turn_id <> ?)", input.excludedTurnId);
		if (input.excludeIdPrefix !== undefined)
			where(
				"substr(id,1,length(?)) <> ?",
				input.excludeIdPrefix,
				input.excludeIdPrefix,
			);
		if (input.excludePendingContextLinks === true)
			where(
				"NOT EXISTS (SELECT 1 FROM session_context_links l WHERE l.target_message_id = messages.id AND l.target_session_id = ? AND (l.first_turn_id IS NULL OR l.first_turn_id = ?) AND l.invalidated_at IS NULL)",
				input.sessionId,
				input.excludedTurnId ?? null,
			);
		const direction = input.direction === "desc" ? "DESC" : "ASC";
		const order =
			input.order === "createdAt"
				? `created_at ${direction}, sequence ${direction}`
				: `sequence ${direction}`;
		let limit = "";
		if (input.limit !== undefined) {
			limit = " LIMIT ?";
			values.push(input.limit);
		}
		const rows = yield* sql.unsafe<MessageRow>(
			`SELECT ${MESSAGE_ROW_COLUMNS} FROM messages WHERE ${filters.join(" AND ")} ORDER BY ${order}${limit}`,
			values,
		);
		return yield* Effect.forEach(rows, messageRecord);
	});
	const messageBoundary = Effect.fn("SqlSessionQueries.messageBoundary")(
		function* (
			sessionId: string,
			messageId?: string,
			excludeIdPrefix?: string,
		) {
			const filters = ["session_id = ?"];
			const values = [sessionId];
			if (messageId !== undefined) {
				filters.push("id = ?");
				values.push(messageId);
			}
			if (excludeIdPrefix !== undefined) {
				filters.push("substr(id,1,length(?)) <> ?");
				values.push(excludeIdPrefix, excludeIdPrefix);
			}
			const rows = yield* sql.unsafe<{ id: string; sequence: number }>(
				`SELECT id,sequence FROM messages WHERE ${filters.join(" AND ")} ORDER BY sequence DESC LIMIT 1`,
				values,
			);
			const row = rows[0];
			return row === undefined
				? null
				: { messageId: row.id, sequence: row.sequence };
		},
	);
	const firstUserMessage = (sessionId: string) =>
		messageList({ sessionId, role: "user", limit: 1 }).pipe(
			Effect.map((rows) => rows[0] ?? null),
		);
	return { messageList, messageBoundary, firstUserMessage };
};
