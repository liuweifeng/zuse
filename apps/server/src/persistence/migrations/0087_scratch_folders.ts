import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const Migration0087ScratchFolders = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project', 'scratch'))`;
});
