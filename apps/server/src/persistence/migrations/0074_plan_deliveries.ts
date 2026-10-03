import { InputRequestOwner } from "@zuse/domain/agent-engine/input-owner";
import {
	createSessionInputProjection,
	projectSessionInput,
} from "@zuse/domain/projectors/sql-input-projector";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const createPlanDeliveryJournal = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE plan_response_deliveries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  turn_id TEXT,
  response_json TEXT NOT NULL,
  owner_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivering','accepted','uncertain','committed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,item_id)
 )`;
	yield* sql`CREATE INDEX plan_response_recovery ON plan_response_deliveries(status,session_id,item_id) WHERE status != 'committed'`;
});

export const Migration0074PlanDeliveries = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* createPlanDeliveryJournal;
	yield* sql`ALTER TABLE session_inputs RENAME TO session_inputs_before_plans`;
	yield* sql`DROP INDEX IF EXISTS session_inputs_expiry_scan`;
	yield* sql`DROP INDEX IF EXISTS session_inputs_pending`;
	yield* createSessionInputProjection(sql);
	yield* sql`INSERT INTO session_inputs SELECT * FROM session_inputs_before_plans`;
	yield* sql`DROP TABLE session_inputs_before_plans`;
	const decodeOwner = Schema.decodeUnknownResult(
		Schema.fromJsonString(InputRequestOwner),
	);
	let after = "";
	while (true) {
		const rows = yield* sql<{
			id: string;
			session_id: string;
			turn_id: string | null;
			sequence: number;
			content_json: string;
			created_at: string;
			owner_json: string | null;
		}>`SELECT m.id,m.session_id,m.turn_id,COALESCE(m.sequence,0) AS sequence,m.content_json,m.created_at,json_extract(e.payload_json,'$.inputOwner') AS owner_json FROM messages m LEFT JOIN events e ON e.sequence=m.sequence AND e.stream_kind='session' AND e.stream_id=m.session_id AND e.type='MessagePersisted' WHERE m.id>${after} AND m.kind='tool_use' AND json_valid(m.content_json) AND json_extract(m.content_json,'$.tool')='ExitPlanMode' ORDER BY m.id LIMIT 500`;
		for (const row of rows) {
			const owner =
				row.owner_json === null ? null : decodeOwner(row.owner_json);
			yield* projectSessionInput(sql, {
				streamId: row.session_id,
				sequence: row.sequence,
				event: {
					_tag: "MessagePersisted",
					messageId: row.id,
					turnId: row.turn_id,
					role: "assistant",
					kind: "tool_use",
					contentJson: row.content_json,
					parentItemId: null,
					createdAt: new Date(row.created_at).getTime(),
					...(owner !== null && Result.isSuccess(owner)
						? { inputOwner: owner.success }
						: {}),
				},
			});
			after = row.id;
		}
		if (rows.length < 500) break;
	}
});
