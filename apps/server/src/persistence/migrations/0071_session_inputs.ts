import { SessionEvent } from "@zuse/domain/core/events";
import {
	createSessionInputProjection,
	projectCommittedMessageInput,
	projectSessionInput,
} from "@zuse/domain/projectors/sql-input-projector";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0071SessionInputs = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* createSessionInputProjection(sql);

	let afterMessageId = "";
	while (true) {
		const rows = yield* sql<{
			sequence: number;
			id: string;
			session_id: string;
			turn_id: string | null;
			kind: string;
			content_json: string;
			created_at: string;
		}>`
			SELECT COALESCE(m.sequence, 0) AS sequence, m.id, m.session_id, m.turn_id, m.kind, m.content_json, m.created_at
			FROM messages m JOIN sessions s ON s.id = m.session_id
			WHERE m.id > ${afterMessageId}
				AND m.kind IN ('user_question', 'user_question_answer')
			ORDER BY m.id LIMIT 500
		`;
		if (rows.length === 0) break;
		for (const row of rows) {
			yield* projectSessionInput(sql, {
				streamId: row.session_id,
				sequence: row.sequence,
				event: {
					_tag: "MessagePersisted",
					messageId: row.id,
					turnId: row.turn_id,
					role: "assistant",
					kind: row.kind,
					contentJson: row.content_json,
					parentItemId: null,
					createdAt: new Date(row.created_at).getTime(),
				},
			});
			afterMessageId = row.id;
		}
	}
	let after = 0;
	while (true) {
		const rows = yield* sql<{
			sequence: number;
			stream_id: string;
			type: string;
			payload_json: string;
		}>`
			SELECT e.sequence, e.stream_id, e.type, e.payload_json
			FROM events e JOIN sessions s ON s.id = e.stream_id
			WHERE e.stream_kind = 'session' AND e.sequence > ${after}
				AND (e.type IN ('PermissionRequested', 'PermissionExpired', 'PermissionResolved', 'QuestionResolved', 'QuestionExpired')
					OR (e.type = 'MessagePersisted' AND json_valid(e.payload_json)
						AND json_type(e.payload_json, '$.inputOwner') = 'object'))
			ORDER BY e.sequence LIMIT 500
		`;
		if (rows.length === 0) break;
		for (const row of rows) {
			const payload = yield* Effect.try(() => JSON.parse(row.payload_json));
			const event = yield* Schema.decodeUnknownEffect(SessionEvent)({
				...payload,
				_tag: row.type,
			});
			yield* (
				event._tag === "MessagePersisted"
					? projectCommittedMessageInput
					: projectSessionInput
			)(sql, {
				streamId: row.stream_id,
				sequence: row.sequence,
				event,
			});
			after = row.sequence;
		}
	}
});
