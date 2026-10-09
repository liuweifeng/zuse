import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { makeSqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { makeOrchestrationReader } from "../../src/conversation/core/orchestration-reader.ts";

const fixture = Effect.gen(function* () {
	yield* createDomainTestSchema();
	const sql = yield* SqlClient.SqlClient;
	const domain = yield* makeSessionDomain(sql, () =>
		Effect.succeed(crypto.randomUUID()),
	);
	yield* domain.dispatch({
		streamId: "session-1",
		commandId: "create",
		command: { ...createSessionCommand, providerId: "codex" },
	});
	for (let i = 1; i <= 5; i++) {
		const content = JSON.stringify({
			_tag: "assistant",
			text: `response ${i}`,
		});
		yield* sql`INSERT INTO messages(id,session_id,role,kind,content_json,created_at,sequence) VALUES (${`m${i}`},'session-1','assistant','assistant',${content},'2026-01-01T00:00:00Z',${i})`;
	}
	return {
		sql,
		read: makeOrchestrationReader(makeSqlSessionQueries(sql), "project-1"),
		queries: makeSqlSessionQueries(sql),
	};
});
const run = <A, E>(
	effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
	Effect.runPromise(
		Effect.scoped(effect).pipe(
			Effect.provide(sqliteLayer({ filename: ":memory:" })),
		),
	);

it("reads bounded forward pages without duplicates and preserves recent-read behavior", async () => {
	await run(
		Effect.gen(function* () {
			const { read } = yield* fixture;
			const recent = yield* read({ sessionId: "session-1", limit: 2 });
			expect(recent.messages.map((m) => m.id)).toEqual(["m4", "m5"]);
			expect(recent.hasMore).toBe(false);
			const first = yield* read({
				sessionId: "session-1",
				afterMessageId: "",
				limit: 2,
			});
			expect(first.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
			expect(first.hasMore).toBe(true);
			const second = yield* read({
				sessionId: "session-1",
				afterMessageId: first.nextMessageId ?? "",
				limit: 2,
			});
			expect(second.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
			const last = yield* read({
				sessionId: "session-1",
				afterMessageId: second.nextMessageId ?? "",
				limit: 2,
			});
			expect(last.messages.map((m) => m.id)).toEqual(["m5"]);
			expect(last.hasMore).toBe(false);
		}),
	);
});

it("chunks large text with a page-wide budget and supports explicit continuation", async () => {
	await run(
		Effect.gen(function* () {
			const { read } = yield* fixture;
			const first = yield* read({
				sessionId: "session-1",
				afterMessageId: "",
				limit: 3,
				maxTextChars: 4,
			});
			expect(first.messages).toMatchObject([
				{ id: "m1", text: "resp", truncated: true, nextTextOffset: 4 },
			]);
			expect(first.hasMore).toBe(true);
			const rest = yield* read({
				sessionId: "session-1",
				messageId: "m1",
				textOffset: 4,
			});
			expect(rest.messages).toMatchObject([
				{ text: "onse 1", truncated: false, nextTextOffset: null },
			]);
			expect(rest.hasMore).toBe(false);
		}),
	);
});

it("rejects foreign projects, missing cursors and invalid chunk offsets", async () => {
	await run(
		Effect.gen(function* () {
			const { read, queries } = yield* fixture;
			for (const input of [
				{ sessionId: "session-1", afterMessageId: "missing" },
				{ sessionId: "session-1", messageId: "m1", textOffset: 100 },
				{ sessionId: "session-1", textOffset: 1 },
				{ sessionId: "session-1", limit: 101 },
			])
				expect((yield* read(input).pipe(Effect.result))._tag).toBe("Failure");
			expect(
				(yield* makeOrchestrationReader(
					queries,
					"other-project",
				)({ sessionId: "session-1" }).pipe(Effect.result))._tag,
			).toBe("Failure");
		}),
	);
});

it("filters activity while retaining stable cursors", async () => {
	await run(
		Effect.gen(function* () {
			const { read, sql } = yield* fixture;
			const content = JSON.stringify({
				_tag: "thinking",
				itemId: "thinking-item",
				text: "private",
				redacted: true,
			});
			yield* sql`INSERT INTO messages(id,session_id,role,kind,content_json,created_at,sequence) VALUES ('thinking','session-1','assistant','thinking',${content},'2026-01-01T00:00:00Z',6)`;
			const activity = yield* read({
				sessionId: "session-1",
				afterMessageId: "m5",
				view: "activity",
			});
			expect(activity.messages[0]?.text).toBe("[redacted thinking]");
			const messages = yield* read({
				sessionId: "session-1",
				afterMessageId: "m5",
				view: "messages",
			});
			expect(messages.messages).toEqual([]);
		}),
	);
});
