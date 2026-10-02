import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	Chat,
	ChatId,
	FolderId,
	MessageId,
	ProviderThreadId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test, vi } from "vitest";
import { makeTranscriptOperations } from "../../src/conversation/core/transcript-operations.ts";

const projectId = FolderId.make("new-project");
const now = new Date(0);
const session = Session.make({
	id: SessionId.make("new-session"),
	chatId: ChatId.make("new-chat"),
	projectId,
	title: "Fork",
	titleProvenance: "manual",
	providerId: "codex",
	model: "model",
	status: "idle",
	archivedAt: null,
	providerThread: {
		id: ProviderThreadId.make("thread-source"),
		provider: "codex",
		nativeThreadRef: {
			provider: "codex",
			nativeId: "cursor",
			strength: "strong",
		},
		nativeHeadRef: null,
		status: "idle",
		firstTurnOrdinal: null,
		lastTurnOrdinal: null,
		createdAt: now,
		updatedAt: now,
	},
	runtimeMode: "full-access",
	worktreeId: null,
	forkedFromSessionId: SessionId.make("source"),
	forkedFromMessageId: MessageId.make("tail"),
	permissionMode: "default",
	toolSearch: false,
	createdAt: now,
	updatedAt: now,
});
const chat = Chat.make({
	id: session.chatId,
	projectId,
	worktreeId: null,
	title: "Fork",
	titleProvenance: "manual",
	activeSessionId: session.id,
	originSessionId: null,
	archivedAt: null,
	lastMessageAt: null,
	lastReadAt: null,
	createdAt: now,
	updatedAt: now,
});

const sourceFixture = (path: string, schema: "legacy" | "engine") => {
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE sessions (id TEXT, chat_id TEXT, project_id TEXT, title TEXT, provider_id TEXT, model TEXT, status TEXT, archived_at TEXT, cursor TEXT, resume_strategy TEXT, runtime_mode TEXT, worktree_id TEXT, forked_from_session_id TEXT, forked_from_message_id TEXT, permission_mode TEXT, tool_search INTEGER, created_at TEXT, updated_at TEXT);
 INSERT INTO sessions VALUES ('source','parent-chat','old-project','Original','codex','model','idle',NULL,'provider-cursor','codex-thread-id','full-access',NULL,NULL,NULL,'default',0,'2026-01-01','2026-01-01');
 CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, kind TEXT, content_json TEXT, parent_item_id TEXT, created_at TEXT, sequence INTEGER);`);
	const insert = db.prepare(
		"INSERT INTO messages VALUES (?, 'source', ?, ?, ?, NULL, '2026-01-01', ?)",
	);
	insert.run(
		"start",
		"user",
		"user",
		JSON.stringify({ _tag: "user", text: "hello" }),
		1,
	);
	insert.run(
		"tail",
		"assistant",
		"assistant",
		JSON.stringify({ _tag: "assistant", text: "world" }),
		2,
	);
	if (schema === "engine") {
		db.exec(`ALTER TABLE sessions ADD COLUMN active_provider_thread_id TEXT;
   CREATE TABLE session_provider_threads (id TEXT, session_id TEXT, provider TEXT, native_thread_id TEXT, native_head_id TEXT, status TEXT, first_turn_ordinal INTEGER, last_turn_ordinal INTEGER, created_at TEXT, updated_at TEXT);
   INSERT INTO session_provider_threads VALUES ('thread-source', 'source', 'codex', 'provider-cursor', NULL, 'idle', NULL, NULL, '2026-01-01', '2026-01-01');
   UPDATE sessions SET active_provider_thread_id = 'thread-source';
   ALTER TABLE sessions DROP COLUMN cursor;
   ALTER TABLE sessions DROP COLUMN resume_strategy;`);
	}
	db.close();
};

describe.each([
	"legacy",
	"engine",
] as const)("machine fork transcript import (%s schema)", (schema) => {
	test.each([
		"start",
		"tail",
	])("imports through %s and replays without duplicate messages", async (point) => {
		const dir = mkdtempSync(join(tmpdir(), "zuse-fork-"));
		const path = join(dir, "source.sqlite");
		sourceFixture(path, schema);
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`PRAGMA foreign_keys = ON`;
					yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY, forked_from_session_id TEXT REFERENCES sessions(id))`;
					yield* sql`CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, content_json TEXT)`;
					const createChat = vi.fn(
						(input: { forkedFromSessionId?: SessionId | null }) =>
							sql`INSERT OR IGNORE INTO sessions VALUES (${session.id}, ${input.forkedFromSessionId ?? null})`.pipe(
								Effect.orDie,
								Effect.as({
									chat,
									initialSession: session,
									initialMessage: null,
								}),
							),
					);
					const ops = makeTranscriptOperations({
						sql,
						createChat,
						createSession: () => Effect.die("must not create a tab"),
						lookupChat: () => Effect.succeed(chat),
						lookupSession: () => Effect.die("must read retained snapshot"),
						persistMessage: (id, content, messageId) =>
							sql`INSERT INTO messages VALUES (${messageId}, ${id}, ${JSON.stringify(content)})`.pipe(
								Effect.orDie,
								Effect.as({ message: {} as never, sequence: 1 }),
							),
					});
					const input = {
						sourceSessionId: SessionId.make("source"),
						fromMessageId: MessageId.make(point),
						destination: "chat" as const,
						chatId: chat.id,
						initialSessionId: session.id,
						commandId: "launch:child",
						sourceSnapshot: {
							databasePath: path,
							chatId: ChatId.make("parent-chat"),
							projectId,
						},
					};
					const result = yield* ops.forkSession(input);
					yield* ops.forkSession(input);
					expect(result.forkMode).toBe(point === "tail" ? "resume" : "copy");
					expect(createChat).toHaveBeenCalledWith(
						expect.objectContaining({
							projectId,
							chatId: "new-chat",
							initialSessionId: "new-session",
							commandId: "launch:child",
							providerThread:
								point === "tail"
									? { nativeThreadId: "provider-cursor", nativeHeadId: null }
									: undefined,
							forkFromResume: point === "tail",
							forkedFromSessionId: null,
						}),
					);
					const rows = yield* sql<{
						id: string;
					}>`SELECT id FROM messages ORDER BY id`;
					expect(rows.map((row) => row.id)).toEqual(
						point === "tail"
							? ["fork:new-session:start", "fork:new-session:tail"]
							: ["fork:new-session:start"],
					);
					const rejected = yield* ops
						.forkSession({
							...input,
							sourceSnapshot: {
								...input.sourceSnapshot,
								chatId: ChatId.make("wrong-chat"),
							},
						})
						.pipe(Effect.result);
					expect(rejected._tag).toBe("Failure");
					expect(createChat).toHaveBeenCalledTimes(2);
				}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
