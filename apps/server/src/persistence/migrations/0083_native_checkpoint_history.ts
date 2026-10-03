import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0083NativeCheckpointHistory = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE session_checkpoints ADD COLUMN native_history_json TEXT`;
	yield* sql`ALTER TABLE session_checkpoints ADD COLUMN root_step_id TEXT`;
	yield* sql`ALTER TABLE session_checkpoint_restores ADD COLUMN native_attempted INTEGER NOT NULL DEFAULT 0`;
	yield* sql`ALTER TABLE session_checkpoint_restores ADD COLUMN native_verified_json TEXT`;
});
