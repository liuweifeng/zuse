import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTurnId, ComposerInput, SessionId } from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { makeContextHandoff } from "../../src/conversation/core/context-handoff.ts";
import { Migration0075ContextHandoffs } from "../../src/persistence/migrations/0075_context_handoffs.ts";

it("keeps a frozen handoff across restart and replaces it when switching again", async () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-handoff-"));
	const filename = join(directory, "db.sqlite");
	let runtime = ManagedRuntime.make(sqliteLayer({ filename }));
	const sessionId = SessionId.make(createSessionCommand.sessionId);
	const session = {
		id: sessionId,
		providerId: "codex" as const,
		providerThread: null,
	};
	const input = new ComposerInput({
		text: "Continue",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
	});
	const turnId = AgentTurnId.make("first-turn");
	let firstText = "";
	try {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* createDomainTestSchema();
					yield* Migration0075ContextHandoffs;
					const sql = yield* SqlClient.SqlClient;
					const domain = yield* makeSessionDomain(sql, () =>
						Effect.succeed(crypto.randomUUID()),
					);
					yield* domain.dispatch({
						commandId: "create",
						streamId: sessionId,
						command: createSessionCommand,
					});
					yield* domain.dispatch({
						commandId: "history",
						streamId: sessionId,
						command: {
							_tag: "PersistMessage",
							messageId: "history",
							turnId: null,
							role: "user",
							kind: "user",
							parentItemId: null,
							createdAt: 1,
							contentJson: JSON.stringify({
								_tag: "user",
								text: "Keep the original design.",
							}),
						},
					});
					const handoffs = makeContextHandoff(sql);
					yield* sql.withTransaction(
						handoffs.capture(sessionId, "codex", "handoff-1"),
					);
					firstText = (yield* handoffs.prepare(session, turnId, input)).text;
					expect(firstText).toContain("Keep the original design.");
					yield* sql`UPDATE messages SET content_json=${JSON.stringify({ _tag: "user", text: "Newly corrected history." })} WHERE id='history'`;
				}),
			),
		);
		await runtime.dispose();
		runtime = ManagedRuntime.make(sqliteLayer({ filename }));
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const handoffs = makeContextHandoff(sql);
				expect((yield* handoffs.prepare(session, turnId, input)).text).toBe(
					firstText,
				);
				expect(
					(yield* handoffs.prepare(
						{ ...session, providerId: "claude" },
						turnId,
						input,
					)).text,
				).toBe("Continue");
				yield* sql.withTransaction(
					handoffs.capture(sessionId, "claude", "handoff-2"),
				);
				const next = yield* handoffs.prepare(
					{ ...session, providerId: "claude" },
					AgentTurnId.make("next-turn"),
					input,
				);
				expect(next.text).toContain("Newly corrected history.");
				expect(next.text).not.toContain("Keep the original design.");
				expect((yield* handoffs.prepare(session, turnId, input)).text).toBe(
					"Continue",
				);
				expect(
					yield* sql`SELECT id FROM session_context_handoffs WHERE active=1`,
				).toEqual([{ id: "handoff-2" }]);
			}),
		);
	} finally {
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
