import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import type { StoredEvent } from "../../../src/engine/dispatch.js";
import { makeSqlSessionProjector } from "../../../src/projectors/sql-session-projector.js";
import { sessionCreation } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
	Effect.runPromise(
		program.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

const stored = (
	sequence: number,
	event: StoredEvent["event"],
	streamId = "session-1",
): StoredEvent => ({
	eventId: `event-${sequence}`,
	correlationId: "command-1",
	causationEventId: null,
	streamId,
	streamVersion: sequence,
	sequence,
	event,
});

describe("SqlSessionProjector", () => {
	test("persists the startup reservation without changing conversation recency", async () => {
		const sessions = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const projector = makeSqlSessionProjector(sql);
				yield* projector.apply(
					stored(1, { _tag: "SessionCreated", ...sessionCreation }),
				);
				yield* projector.apply(
					stored(2, {
						_tag: "ProviderSessionReserved",
						providerId: "provider-1",
						providerSessionId: "starting",
						reservedAt: 42,
					}),
				);
				return yield* sql<{
					readonly updated_at: string;
					readonly provider_reservation_id: string;
				}>`SELECT updated_at, provider_reservation_id FROM sessions WHERE id = 'session-1'`;
			}),
		);
		expect(sessions[0]).toEqual({
			updated_at: new Date(sessionCreation.createdAt).toISOString(),
			provider_reservation_id: "starting",
		});
	});

	test("repairs the active chat session when a thread is archived or deleted", async () => {
		const activeSessionIds = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				const projector = makeSqlSessionProjector(sql);
				yield* projector.apply(
					stored(1, { _tag: "SessionCreated", ...sessionCreation }),
				);
				yield* projector.apply(
					stored(
						2,
						{
							_tag: "SessionCreated",
							...sessionCreation,
							sessionId: "session-2",
							createdAt: 2,
						},
						"session-2",
					),
				);
				const readActive = Effect.gen(function* () {
					const rows = yield* sql<{
						readonly active_session_id: string | null;
					}>`SELECT active_session_id FROM chats WHERE id = 'chat-1'`;
					return rows[0]?.active_session_id ?? null;
				});
				const afterCreate = yield* readActive;
				yield* projector.apply(
					stored(3, { _tag: "SessionArchived", archivedAt: 3 }, "session-2"),
				);
				const afterArchive = yield* readActive;
				yield* projector.apply(
					stored(4, { _tag: "SessionDeleted", deletedAt: 4 }, "session-1"),
				);
				const afterDelete = yield* readActive;
				return { afterCreate, afterArchive, afterDelete };
			}),
		);

		expect(activeSessionIds).toEqual({
			afterCreate: "session-2",
			afterArchive: "session-1",
			afterDelete: null,
		});
	});

	test("advances user recency only for user messages and never regresses on replay", async () => {
		const snapshots = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO chats (id, updated_at) VALUES ('chat-1', '1970-01-01T00:00:00.000Z')`;
				const projector = makeSqlSessionProjector(sql);
				yield* projector.apply(
					stored(1, { _tag: "SessionCreated", ...sessionCreation }),
				);
				const snapshots = [];
				for (const [index, [role, createdAt]] of (
					[
						["user", 20],
						["assistant", 40],
						["user", 60],
						["user", 10],
					] as const
				).entries()) {
					yield* projector.apply(
						stored(index + 2, {
							_tag: "MessagePersisted",
							messageId: `message-${index}`,
							turnId: null,
							role,
							kind: "text",
							contentJson: "{}",
							parentItemId: null,
							createdAt,
						}),
					);
					const rows = yield* sql<{
						last_user_message_at: string | null;
						last_message_at: string | null;
					}>`SELECT last_user_message_at, last_message_at FROM chats`;
					snapshots.push(rows[0]);
				}
				yield* projector.apply(
					stored(10, {
						_tag: "QueuedTurnEnqueued",
						queueId: "queued-1",
						position: 0,
						inputJson: "{}",
						ready: true,
						createdAt: 80,
					}),
				);
				const queued = yield* sql<{
					last_user_message_at: string | null;
					last_message_at: string | null;
				}>`SELECT last_user_message_at, last_message_at FROM chats`;
				snapshots.push(queued[0]);
				return snapshots;
			}),
		);
		expect(snapshots.map((row) => row?.last_user_message_at)).toEqual(
			[20, 20, 60, 60, 80].map((time) => new Date(time).toISOString()),
		);
		expect(snapshots[1]?.last_message_at).toBe(new Date(40).toISOString());
	});

	test("rebuilds a complete session and byte-identical message row", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				const projector = makeSqlSessionProjector(sql);
				yield* projector.apply(
					stored(1, { _tag: "SessionCreated", ...sessionCreation }),
				);
				yield* projector.apply(
					stored(2, {
						_tag: "MessagePersisted",
						messageId: "message-1",
						turnId: null,
						role: "user",
						kind: "text",
						contentJson: '{"spacing":  "preserved"}',
						parentItemId: null,
						createdAt: 20,
					}),
				);
				const sessions = yield* sql<{
					readonly id: string;
					readonly provider_id: string;
					readonly model: string;
					readonly runtime_mode: string;
				}>`SELECT id, provider_id, model, runtime_mode FROM sessions`;
				const messages = yield* sql<{
					readonly content_json: string;
					readonly sequence: number;
				}>`SELECT content_json, sequence FROM messages`;
				const chats = yield* sql<{
					readonly active_session_id: string | null;
					readonly last_message_at: string | null;
				}>`SELECT active_session_id, last_message_at FROM chats`;
				return { sessions, messages, chats };
			}),
		);

		expect(result.sessions).toEqual([
			{
				id: "session-1",
				provider_id: "provider-1",
				model: "model-1",
				runtime_mode: "approval-required",
			},
		]);
		expect(result.messages).toEqual([
			{ content_json: '{"spacing":  "preserved"}', sequence: 2 },
		]);
		expect(result.chats).toEqual([
			{
				active_session_id: "session-1",
				last_message_at: new Date(20).toISOString(),
			},
		]);
	});

	test("defaults queue state for creation events written before that field existed", async () => {
		const { queuePaused: _, ...legacyCreation } = sessionCreation;
		const queuePaused = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				yield* makeSqlSessionProjector(sql).apply(
					stored(1, { _tag: "SessionCreated", ...legacyCreation }),
				);
				const rows = yield* sql<{ readonly queue_paused: number }>`
					SELECT queue_paused FROM sessions WHERE id = 'session-1'
				`;
				return rows[0]?.queue_paused;
			}),
		);
		expect(queuePaused).toBe(0);
	});

	test("conditionally upserts only newer checkpoints and seals final rows", async () => {
		const rows = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				const projector = makeSqlSessionProjector(sql);
				yield* projector.apply(
					stored(1, { _tag: "SessionCreated", ...sessionCreation }),
				);
				const checkpoint = (
					sequence: number,
					revision: number,
					text: string,
					final = false,
				) =>
					projector.apply(
						stored(sequence, {
							_tag: "MessagePersisted",
							messageId: "provider-message-1",
							turnId: "turn-1",
							role: "assistant",
							kind: "assistant",
							contentJson: JSON.stringify({ _tag: "assistant", text }),
							parentItemId: null,
							checkpointRevision: revision,
							checkpointFinal: final,
							createdAt: sequence,
						}),
					);
				yield* checkpoint(2, 2, "new");
				yield* checkpoint(3, 1, "old");
				yield* checkpoint(4, 2, "duplicate");
				yield* checkpoint(5, 3, "final", true);
				yield* checkpoint(6, 4, "after-final");
				return yield* sql<{
					readonly content_json: string;
					readonly checkpoint_revision: number;
					readonly checkpoint_final: number;
				}>`
					SELECT content_json, checkpoint_revision, checkpoint_final
					FROM messages WHERE id = 'provider-message-1'
				`;
			}),
		);

		expect(rows).toEqual([
			{
				content_json: '{"_tag":"assistant","text":"final"}',
				checkpoint_revision: 3,
				checkpoint_final: 1,
			},
		]);
	});
	test("projects input lifecycle transactionally without reopening resolved requests", async () => {
		await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO chats (id, updated_at) VALUES ('chat-1', '1970-01-01T00:00:00.000Z')`;
				const projector = makeSqlSessionProjector(sql);
				yield* projector.apply(
					stored(1, { _tag: "SessionCreated", ...sessionCreation }),
				);
				const request: StoredEvent["event"] = {
					_tag: "MessagePersisted",
					inputOwner: { providerSessionId: "original-provider" },
					messageId: "question",
					turnId: null,
					role: "assistant",
					kind: "user_question",
					parentItemId: null,
					createdAt: 2,
					contentJson: JSON.stringify({
						_tag: "user_question",
						itemId: "shared-id",
						questions: [{ question: "Choose", options: ["A"] }],
					}),
				};
				yield* projector.apply(stored(2, request));
				yield* projector.apply(
					stored(3, {
						_tag: "PermissionRequested",
						requestId: "shared-id",
						turnId: "turn",
						payloadJson: "{}",
						requestedAt: 3,
					}),
				);
				yield* projector.apply(
					stored(4, {
						_tag: "PermissionExpired",
						requestId: "shared-id",
						expiredAt: 4,
					}),
				);
				expect(
					yield* sql`SELECT kind, status FROM session_inputs ORDER BY kind`,
				).toEqual([
					{ kind: "permission", status: "expired" },
					{ kind: "question", status: "pending" },
				]);
				const cancelled: StoredEvent["event"] = {
					_tag: "QuestionResolved",
					itemId: "shared-id",
					resolution: "cancelled",
					resolvedAt: 5,
				};
				yield* sql
					.withTransaction(
						projector
							.apply(stored(5, cancelled))
							.pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.result);
				expect(
					yield* sql`SELECT status FROM session_inputs WHERE kind = 'question'`,
				).toEqual([{ status: "pending" }]);
				yield* projector.apply(stored(5, cancelled));
				yield* projector.apply(
					stored(6, {
						...request,
						messageId: "later-question",
						turnId: "later-turn",
						inputOwner: { providerSessionId: "later-provider" },
					}),
				);
				expect(
					yield* sql`SELECT turn_id, owner_json FROM session_inputs WHERE kind = 'question'`,
				).toEqual([
					{
						turn_id: null,
						owner_json: JSON.stringify({
							providerSessionId: "original-provider",
						}),
					},
				]);
				yield* projector.apply(
					stored(7, {
						_tag: "PermissionResolved",
						requestId: "shared-id",
						decision: "Deny",
						resolvedAt: 7,
					}),
				);
				yield* projector.apply(
					stored(4, {
						_tag: "PermissionExpired",
						requestId: "shared-id",
						expiredAt: 4,
					}),
				);
				expect(
					yield* sql`SELECT kind, status FROM session_inputs ORDER BY kind`,
				).toEqual([
					{ kind: "permission", status: "answered" },
					{ kind: "question", status: "cancelled" },
				]);
			}),
		);
	});
});
