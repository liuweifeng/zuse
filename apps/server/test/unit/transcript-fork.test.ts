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
import { nativeChildThread } from "../support/native-child-thread.ts";

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
					yield* sql`CREATE TABLE session_fork_constructions (session_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT,cancelled_at INTEGER,completed_at INTEGER)`;
					yield* sql`CREATE TABLE session_context_handoffs (id TEXT PRIMARY KEY,session_id TEXT,provider_id TEXT,context_text TEXT,first_turn_id TEXT,active INTEGER DEFAULT 1,created_at INTEGER,resume_thread_id TEXT,fallback_context_text TEXT,fallback_at INTEGER)`;
					yield* sql`CREATE TABLE session_context_links (target_message_id TEXT,target_session_id TEXT,first_turn_id TEXT,invalidated_at INTEGER)`;
					yield* sql`CREATE TABLE chats (id TEXT PRIMARY KEY)`;
					yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY, forked_from_session_id TEXT REFERENCES sessions(id))`;
					yield* sql`CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, content_json TEXT, role TEXT, kind TEXT, parent_item_id TEXT, created_at TEXT, sequence INTEGER,turn_id TEXT,checkpoint_revision INTEGER,checkpoint_final INTEGER)`;
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
						lookupSession: (id) =>
							id === session.id
								? Effect.succeed(session)
								: Effect.die("must read retained snapshot"),
						persistMessage: (id, content, messageId) =>
							sql`INSERT OR IGNORE INTO messages (id,session_id,content_json,role,kind,parent_item_id,created_at,sequence) VALUES (${messageId}, ${id}, ${JSON.stringify(content)}, ${content._tag === "user" ? "user" : "assistant"}, ${content._tag}, NULL, ${new Date().toISOString()}, (SELECT COUNT(*) + 1 FROM messages))`.pipe(
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
					expect(result.forkMode).toBe("copy");
					expect(createChat).toHaveBeenCalledWith(
						expect.objectContaining({
							projectId,
							chatId: "new-chat",
							initialSessionId: "new-session",
							commandId: "launch:child",
							providerThread: undefined,
							forkFromResume: false,
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
					expect(createChat).toHaveBeenCalledTimes(1);
				}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("completed native child fork freezes full context and retries without re-reading mutable provider history", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE session_fork_constructions (session_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT,cancelled_at INTEGER,completed_at INTEGER)`;
			yield* sql`CREATE TABLE session_context_handoffs (id TEXT PRIMARY KEY,session_id TEXT,provider_id TEXT,context_text TEXT,first_turn_id TEXT,active INTEGER DEFAULT 1,created_at INTEGER,resume_thread_id TEXT,fallback_context_text TEXT,fallback_at INTEGER)`;
			yield* sql`CREATE TABLE session_context_links (target_message_id TEXT,target_session_id TEXT,first_turn_id TEXT,invalidated_at INTEGER)`;
			yield* sql`CREATE TABLE chats (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE messages (id TEXT PRIMARY KEY,session_id TEXT,content_json TEXT,role TEXT,kind TEXT,parent_item_id TEXT,created_at TEXT,sequence INTEGER,turn_id TEXT,checkpoint_revision INTEGER,checkpoint_final INTEGER)`;
			yield* sql`CREATE TABLE session_execution_steps(id TEXT,session_id TEXT,attempt_id TEXT,turn_id TEXT,native_child_id TEXT,status TEXT,kind TEXT)`;
			yield* sql`CREATE TABLE session_attempts(id TEXT,session_id TEXT,turn_id TEXT,provider_turn_json TEXT)`;
			yield* sql`INSERT INTO sessions VALUES('source')`;
			yield* sql`INSERT INTO chats VALUES(${chat.id})`;
			yield* sql`INSERT INTO messages VALUES('summary','source','{"_tag":"assistant","text":"only parent summary"}','assistant','assistant',NULL,'2026-01-01',1,NULL,NULL,NULL)`;
			yield* sql`INSERT INTO session_execution_steps VALUES('exact-step','source','attempt','turn','child','completed','subagent')`;
			yield* sql`INSERT INTO session_attempts VALUES('attempt','source','turn',${JSON.stringify({ provider: "codex", nativeThreadId: "parent", nativeTurnId: "root-turn" })})`;
			let reads = 0;
			let invalidateDuringRead = false;
			const source = Session.make({ ...session, id: SessionId.make("source") });
			const ops = makeTranscriptOperations({
				sql,
				lookupSession: (id) =>
					Effect.succeed(id === source.id ? source : session),
				lookupChat: () => Effect.succeed(chat),
				createChat: () => Effect.die("tab only"),
				createSession: () =>
					sql`INSERT INTO sessions VALUES(${session.id})`.pipe(
						Effect.orDie,
						Effect.as(session),
					),
				inspectNativeChildThread: () =>
					Effect.gen(function* () {
						if (invalidateDuringRead)
							yield* sql`UPDATE session_execution_steps SET status='cancelled'`.pipe(
								Effect.orDie,
							);
						reads++;
						return nativeChildThread();
					}),
				persistMessage: (id, content, messageId) =>
					sql`INSERT OR IGNORE INTO messages VALUES(${messageId},${id},${JSON.stringify(content)},${content._tag === "user" ? "user" : "assistant"},${content._tag},NULL,'2026-01-01',(SELECT COUNT(*)+1 FROM messages),NULL,NULL,NULL)`.pipe(
						Effect.orDie,
						Effect.as({ message: {} as never, sequence: 1 }),
					),
			});
			const input = {
				sourceSessionId: source.id,
				fromMessageId: MessageId.make("summary"),
				nativeChildStepId: "exact-step",
				destination: "tab" as const,
				initialSessionId: session.id,
				commandId: "native-child-fork",
			};
			const result = yield* ops.forkSession(input);
			expect(result.forkMode).toBe("copy");
			yield* sql`UPDATE session_execution_steps SET status='running'`;
			yield* ops.forkSession(input);
			expect(reads).toBe(1);
			const imported = yield* sql<{
				content_json: string;
			}>`SELECT content_json FROM messages WHERE session_id=${session.id} ORDER BY sequence`;
			expect(imported.map((row) => JSON.parse(row.content_json).text)).toEqual([
				"child assignment",
				"child actual output",
			]);
			const handoffs = yield* sql<{
				context_text: string;
			}>`SELECT context_text FROM session_context_handoffs WHERE session_id=${session.id}`;
			expect(handoffs[0]?.context_text).toContain("child assignment");
			expect(handoffs[0]?.context_text).toContain("child actual output");
			expect(handoffs[0]?.context_text).not.toContain("only parent summary");
			yield* sql`UPDATE session_execution_steps SET status='completed'`;
			invalidateDuringRead = true;
			const invalidated = yield* ops
				.forkSession({
					...input,
					commandId: "race-fork",
					initialSessionId: SessionId.make("racing-destination"),
				})
				.pipe(Effect.result);
			expect(invalidated).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "SessionStartError" },
			});
			expect(
				(yield* sql`SELECT session_id FROM session_fork_constructions`).length,
			).toBe(1);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
