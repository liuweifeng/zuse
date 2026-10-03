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
import { makeProviderContexts } from "../../src/conversation/core/provider-contexts.ts";
import { Migration0075ContextHandoffs } from "../../src/persistence/migrations/0075_context_handoffs.ts";
import { Migration0081ProviderContexts } from "../../src/persistence/migrations/0081_provider_contexts.ts";

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
					yield* Migration0081ProviderContexts;
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

it("returns with missed context-link holes exactly once and freezes its full fallback", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				yield* Migration0075ContextHandoffs;
				yield* Migration0081ProviderContexts;
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				const sessionId = SessionId.make(createSessionCommand.sessionId);
				yield* domain.dispatch({
					commandId: "create",
					streamId: sessionId,
					command: { ...createSessionCommand, providerId: "claude" },
				});
				const persist = (id: string, text: string) =>
					domain.dispatch({
						commandId: id,
						streamId: sessionId,
						command: {
							_tag: "PersistMessage",
							messageId: id,
							turnId: null,
							role: "user",
							kind: "user",
							parentItemId: null,
							createdAt: Date.now(),
							contentJson: JSON.stringify({ _tag: "user", text }),
						},
					});
				yield* persist("known", "Already seen original history");
				yield* persist(
					"pending",
					"A merged result the original provider has not seen",
				);
				yield* sql`INSERT INTO session_context_links(id,kind,source_session_id,target_session_id,target_message_id,source_sequence,context_text,after_turn_ordinal,created_at) VALUES ('link','merge_back','child',${sessionId},'pending',1,'A merged result the original provider has not seen',0,1)`;
				yield* persist("later-known", "Already seen later native response");
				yield* domain.dispatch({
					commandId: "bind",
					streamId: sessionId,
					command: {
						_tag: "BindProviderThread",
						nativeThreadId: "native-original",
						nativeHeadId: null,
						updatedAt: Date.now(),
					},
				});
				const threads = yield* sql<{
					id: string;
					provider: string;
				}>`SELECT id,provider FROM session_provider_threads WHERE session_id=${sessionId}`;
				const contexts = makeProviderContexts(sql);
				yield* contexts.remember(sessionId, threads[0]!.id);
				// Another provider consumed the link, despite its canonical message being
				// below the original provider's last visible sequence.
				yield* sql`UPDATE session_context_links SET first_turn_id='other-provider-turn' WHERE id='link'`;
				yield* persist("other", "New other-provider response");
				const resume = yield* contexts.returning(sessionId, "claude");
				expect(resume).not.toBeNull();
				const handoffs = makeContextHandoff(sql);
				yield* handoffs.capture(sessionId, "claude", "return", resume!);
				const session = {
					id: sessionId,
					providerId: "claude" as const,
					providerThread: null,
				};
				const turnId = AgentTurnId.make("return-turn");
				const input = new ComposerInput({
					text: "Current request",
					attachments: [],
					fileRefs: [],
					skillRefs: [],
				});
				const prepared = yield* handoffs.prepare(session, turnId, input);
				expect(
					prepared.text.match(
						/A merged result the original provider has not seen/g,
					),
				).toHaveLength(1);
				expect(prepared.text).toContain("New other-provider response");
				expect(prepared.text).not.toContain("Already seen");
				expect((yield* handoffs.prepare(session, turnId, input)).text).toBe(
					prepared.text,
				);
				yield* persist("future", "Future edit after frozen return");
				const fallback = yield* handoffs.prepareFallback(
					session,
					turnId,
					input,
				);
				expect(fallback.text).toContain("Already seen original history");
				expect(fallback.text).toContain("Already seen later native response");
				expect(
					fallback.text.match(
						/A merged result the original provider has not seen/g,
					),
				).toHaveLength(1);
				expect(fallback.text).not.toContain("Future edit after frozen return");
				expect((yield* handoffs.prepare(session, turnId, input)).text).toBe(
					fallback.text,
				);
				const laterTurnId = AgentTurnId.make("later-native-loss");
				yield* persist("current-request", "Current request");
				yield* sql`UPDATE messages SET turn_id=${laterTurnId} WHERE id='current-request'`;
				const laterFallback = yield* handoffs.prepareFallback(
					session,
					laterTurnId,
					input,
				);
				expect(laterFallback.text).toContain("Future edit after frozen return");
				expect(laterFallback.text.match(/Current request/g)).toHaveLength(1);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
