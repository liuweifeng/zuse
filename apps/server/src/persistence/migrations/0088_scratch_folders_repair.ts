import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Migration0087ScratchFolders } from "./0087_scratch_folders.ts";

/** Slot 87 was also used by a preview build's masters migration. */
export const Migration0088ScratchFoldersRepair = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = yield* sql<{ name: string }>`PRAGMA table_info(projects)`;
	if (!columns.some((column) => column.name === "kind")) {
		yield* Migration0087ScratchFolders;
	}
});
