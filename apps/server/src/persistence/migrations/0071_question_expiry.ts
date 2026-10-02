import { createSessionInputProjection } from "@zuse/domain/projectors/sql-input-projector";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0071QuestionExpiry = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql<{
		name: string;
	}>`PRAGMA table_info(session_inputs)`;
	if (!columns.some((column) => column.name === "awaiting_dismissal"))
		yield* sql`ALTER TABLE session_inputs ADD COLUMN awaiting_dismissal INTEGER NOT NULL DEFAULT 0`;
	yield* createSessionInputProjection(sql);
});
