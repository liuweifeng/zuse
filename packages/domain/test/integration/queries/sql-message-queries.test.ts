import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { makeSqlMessageQueries } from "../../../src/queries/sql-message-queries.js";

test("keeps transcript ordering, merge boundaries, handoff exclusions and deleted child reads consistent", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE messages (id TEXT,session_id TEXT,turn_id TEXT,role TEXT,kind TEXT,content_json TEXT,parent_item_id TEXT,created_at TEXT,sequence INTEGER,checkpoint_revision INTEGER,checkpoint_final INTEGER)`;
			yield* sql`CREATE TABLE session_context_links (target_message_id TEXT,target_session_id TEXT,first_turn_id TEXT,invalidated_at INTEGER)`;
			for (const [id, sequence, date, turn, role, kind] of [
				["fork:s:copied", 1, "2026-01-03", null, "assistant", "user"],
				["first", 2, "2026-01-01", "old", "user", "user_rich"],
				["pending", 3, "2025-12-31", null, "user", "user"],
				["active", 4, "2026-01-04", "current", "assistant", "assistant"],
				["last", 5, "2026-01-05", "old", "assistant", "assistant"],
			] as const)
				yield* sql`INSERT INTO messages VALUES (${id},'s',${turn},${role},${kind},'{}',NULL,${date},${sequence},7,1)`;
			yield* sql`INSERT INTO session_context_links VALUES ('pending','s',NULL,NULL)`;
			const queries = makeSqlMessageQueries(sql);
			expect(
				(yield* queries.messageList({
					sessionId: "s",
					order: "createdAt",
				})).map((m) => m.messageId),
			).toEqual(["pending", "first", "fork:s:copied", "active", "last"]);
			expect((yield* queries.firstUserMessage("s"))?.messageId).toBe("first");
			expect(yield* queries.messageBoundary("s", undefined, "fork:s:")).toEqual(
				{ messageId: "last", sequence: 5 },
			);
			expect(
				yield* queries.messageBoundary("s", "fork:s:copied", "fork:s:"),
			).toBeNull();
			const handoff = yield* queries.messageList({
				sessionId: "s",
				excludedTurnId: "current",
				excludePendingContextLinks: true,
				excludeIdPrefix: "fork:s:",
				direction: "desc",
				limit: 2,
			});
			expect(handoff.map((m) => m.messageId)).toEqual(["last", "first"]);
			expect(handoff[0]).toMatchObject({
				turnId: "old",
				checkpointRevision: 7,
				checkpointFinal: true,
			});
			expect(
				(yield* queries.messageList({
					sessionId: "s",
					afterSequence: 2,
					throughSequence: 4,
					kinds: ["assistant"],
				})).map((m) => m.messageId),
			).toEqual(["active"]);
			expect(
				(yield* queries.messageList({
					sessionId: "s",
					turnId: "old",
					direction: "desc",
					limit: 1,
				})).map((m) => m.messageId),
			).toEqual(["last"]);
			expect(
				yield* queries.messageList({ sessionId: "deleted-child" }),
			).toEqual([]);
			expect(yield* queries.messageList({ sessionId: "s", kinds: [] })).toEqual(
				[],
			);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
