import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { Migration0069AttemptProviderTurn } from "../../src/persistence/migrations/0069_attempt_provider_turn.ts";

test("upgrades attempt history without guessing historical execution identity", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE session_attempts (id TEXT PRIMARY KEY)`;
			yield* sql`INSERT INTO session_attempts (id) VALUES ('historical')`;
			yield* Migration0069AttemptProviderTurn;
			expect(
				yield* sql`SELECT provider_turn_json FROM session_attempts WHERE id = 'historical'`,
			).toEqual([{ provider_turn_json: null }]);
			const reference = JSON.stringify({
				provider: "codex",
				nativeThreadId: "thread",
				nativeTurnId: "turn",
			});
			yield* sql`UPDATE session_attempts SET provider_turn_json = ${reference}`;
			yield* Migration0069AttemptProviderTurn;
			expect(
				yield* sql`SELECT provider_turn_json FROM session_attempts`,
			).toEqual([{ provider_turn_json: reference }]);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
