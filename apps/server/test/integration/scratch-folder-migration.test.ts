import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Migration0087ScratchFolders } from "../../src/persistence/migrations/0087_scratch_folders.ts";

it("preserves existing projects and defaults newly registered projects to ordinary folders", async () => {
	const rows = await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL)`;
			yield* sql`INSERT INTO projects VALUES ('existing', '/repos/existing')`;
			yield* Migration0087ScratchFolders;
			yield* sql`INSERT INTO projects (id, path) VALUES ('new', '/repos/new')`;
			yield* sql`INSERT INTO projects (id, path, kind) VALUES ('scratch', '/scratch/task', 'scratch')`;
			return yield* sql`SELECT id, path, kind FROM projects ORDER BY id`;
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
	expect(rows).toEqual([
		{ id: "existing", path: "/repos/existing", kind: "project" },
		{ id: "new", path: "/repos/new", kind: "project" },
		{ id: "scratch", path: "/scratch/task", kind: "scratch" },
	]);
});
