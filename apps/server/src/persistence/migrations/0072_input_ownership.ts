import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Migration0071SessionInputs } from "./0071_session_inputs.ts";

export const Migration0072InputOwnership = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql<{
		name: string;
	}>`PRAGMA table_info(session_inputs)`;
	if (!columns.some((column) => column.name === "owner_json"))
		yield* sql`ALTER TABLE session_inputs ADD COLUMN owner_json TEXT`;
	if (!columns.some((column) => column.name === "turn_id"))
		yield* sql`ALTER TABLE session_inputs ADD COLUMN turn_id TEXT`;
	if (!columns.some((column) => column.name === "awaiting_dismissal"))
		yield* sql`ALTER TABLE session_inputs ADD COLUMN awaiting_dismissal INTEGER NOT NULL DEFAULT 0`;
	// Backfill original turn attribution and any recorded owner, never today's owner.
	yield* Migration0071SessionInputs;
});
