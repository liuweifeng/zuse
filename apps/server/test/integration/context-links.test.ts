import {
	AgentTurnId,
	ComposerInput,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { makeContextHandoff } from "../../src/conversation/core/context-handoff.ts";
import {
	invalidateContextLinksForRollback,
	makeContextLinks,
} from "../../src/conversation/core/context-links.ts";
import { Migration0075ContextHandoffs } from "../../src/persistence/migrations/0075_context_handoffs.ts";
import { Migration0081ProviderContexts } from "../../src/persistence/migrations/0081_provider_contexts.ts";

it("supersedes consumed and pending links during rollback and injects only retained history", async () => {
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
					command: createSessionCommand,
				});
				const links = makeContextLinks(sql);
				for (const [id, text] of [
					["keep", "Retained result"],
					["remove", "Deleted future result"],
				] as const) {
					yield* domain.dispatch({
						commandId: `message:${id}`,
						streamId: sessionId,
						command: {
							_tag: "PersistMessage",
							messageId: id,
							turnId: null,
							role: "user",
							kind: "user",
							contentJson: JSON.stringify({ _tag: "user", text }),
							parentItemId: null,
							createdAt: 1,
						},
					});
					yield* links.capture({
						id,
						kind: "subagent_result",
						sourceSessionId: SessionId.make("child"),
						targetSessionId: sessionId,
						targetMessageId: MessageId.make(id),
						baseMessageId: null,
						sourceMessageId: null,
						sourceSequence: 1,
						contextText: text,
					});
				}
				const firstTurn = AgentTurnId.make("first-turn");
				yield* domain.dispatch({
					commandId: "first",
					streamId: sessionId,
					command: { _tag: "StartTurn", turnId: firstTurn, startedAt: 2 },
				});
				const input = ComposerInput.make({
					text: "Continue",
					attachments: [],
					fileRefs: [],
					skillRefs: [],
				});
				const original = yield* links.prepare(sessionId, firstTurn, input);
				expect(original.text).toContain("Deleted future result");
				expect(
					(yield* makeContextLinks(sql).prepare(sessionId, firstTurn, input))
						.text,
				).toBe(original.text);
				yield* domain.dispatch({
					commandId: "settle",
					streamId: sessionId,
					command: {
						_tag: "SettleTurn",
						turnId: firstTurn,
						outcome: "completed",
						settledAt: 3,
					},
				});
				// A result that arrived after this turn had already consumed its context stays pending.
				yield* links.capture({
					id: "pending-future",
					kind: "merge_back",
					sourceSessionId: SessionId.make("child"),
					targetSessionId: sessionId,
					targetMessageId: MessageId.make("remove"),
					baseMessageId: null,
					sourceMessageId: null,
					sourceSequence: 2,
					contextText: "Pending future result",
				});
				yield* domain.dispatch({
					commandId: "native",
					streamId: sessionId,
					command: {
						_tag: "BindProviderThread",
						nativeThreadId: "native-before-rollback",
						nativeHeadId: null,
						updatedAt: Date.now(),
					},
				});
				yield* sql`INSERT INTO session_provider_contexts(provider_thread_id,session_id,through_sequence,pending_message_ids_json,updated_at) SELECT id,session_id,2,'[]',1 FROM session_provider_threads WHERE session_id=${sessionId}`;
				expect(
					yield* sql`SELECT provider_thread_id FROM session_provider_contexts`,
				).toHaveLength(1);
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`DELETE FROM messages WHERE id='remove'`;
						yield* invalidateContextLinksForRollback(sql, sessionId);
						expect(
							yield* sql`SELECT provider_thread_id FROM session_provider_contexts`,
						).toHaveLength(0);
						yield* makeContextHandoff(sql).capture(
							sessionId,
							"codex",
							"rollback",
						);
					}),
				);
				const secondTurn = AgentTurnId.make("second-turn");
				yield* domain.dispatch({
					commandId: "second",
					streamId: sessionId,
					command: { _tag: "StartTurn", turnId: secondTurn, startedAt: 4 },
				});
				const restored = yield* makeContextHandoff(sql).prepare(
					{ id: sessionId, providerId: "codex", providerThread: null },
					secondTurn,
					input,
				);
				expect(restored.text).toContain("Retained result");
				expect(restored.text).not.toContain("Deleted future result");
				expect(restored.text).not.toContain("Pending future result");
				expect(
					(yield* links.list(sessionId)).every(
						(link) => link.invalidatedAt !== null,
					),
				).toBe(true);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
