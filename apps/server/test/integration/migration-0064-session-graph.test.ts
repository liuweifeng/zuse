import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import {
	MigrationsLive,
	MigrationsThrough0045Live,
} from "../../src/persistence/migrations.ts";

const migratedRuntime = (
	filename: string,
	migrations: typeof MigrationsLive,
) => {
	const sqlite = sqliteLayer({ filename, disableWAL: true });
	return ManagedRuntime.make(
		Layer.merge(sqlite, migrations.pipe(Layer.provide(sqlite))),
	);
};

const at = (offsetMinutes: number) =>
	new Date(Date.UTC(2026, 0, 1, 0, offsetMinutes)).toISOString();

describe("migration 0064 session graph", () => {
	it("turns resume tokens into provider threads and turn events into turns", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-migration-0064-"));
		const filename = join(directory, "zuse.sqlite");
		const legacyRuntime = migratedRuntime(filename, MigrationsThrough0045Live);
		try {
			await legacyRuntime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO projects (id, path, name, created_at, updated_at)
						VALUES ('project-1', '/tmp/project-1', 'Project', ${at(0)}, ${at(0)})
					`;
					yield* sql`
						INSERT INTO chats (id, project_id, title, created_at, updated_at)
						VALUES ('chat-1', 'project-1', 'Chat', ${at(0)}, ${at(0)})
					`;
					yield* sql`
						INSERT INTO sessions
							(id, project_id, title, provider_id, model, status, chat_id,
							 cursor, resume_strategy, provider_event_cursor,
							 created_at, updated_at)
						VALUES ('session-1', 'project-1', 'Chat', 'claude', 'opus', 'running',
							'chat-1', 'claude-session-abc', 'claude-session-id', 'event-9',
							${at(0)}, ${at(5)})
					`;
					yield* sql`
						UPDATE chats SET active_session_id = 'session-1' WHERE id = 'chat-1'
					`;
					const events = [
						["e1", 1, "TurnStarted", { turnId: "turn_a", startedAt: 1 }],
						[
							"e2",
							2,
							"TurnSettled",
							{ turnId: "turn_a", outcome: "completed", settledAt: 2 },
						],
						["e3", 3, "TurnStarted", { turnId: "turn_b", startedAt: 3 }],
						[
							"e4",
							4,
							"TurnSettled",
							{ turnId: "turn_b", outcome: "error", settledAt: 4 },
						],
						["e5", 5, "TurnStarted", { turnId: "turn_c", startedAt: 5 }],
					] as const;
					for (const [eventId, version, type, payload] of events) {
						yield* sql`
							INSERT INTO events
								(event_id, stream_kind, stream_id, stream_version, type,
								 occurred_at, actor, payload_json)
							VALUES (${eventId}, 'session', 'session-1', ${version}, ${type},
								${at(version)}, NULL, ${JSON.stringify({ _tag: type, ...payload })})
						`;
					}
				}),
			);
			await legacyRuntime.dispose();

			const currentRuntime = migratedRuntime(filename, MigrationsLive);
			try {
				const result = await currentRuntime.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const threads = yield* sql<{
							readonly id: string;
							readonly provider: string;
							readonly native_thread_id: string;
							readonly native_head_id: string | null;
							readonly status: string;
						}>`
							SELECT id, provider, native_thread_id, native_head_id, status
							FROM session_provider_threads WHERE session_id = 'session-1'
						`;
						const session = yield* sql<{
							readonly active_provider_thread_id: string | null;
						}>`
							SELECT active_provider_thread_id FROM sessions WHERE id = 'session-1'
						`;
						const turns = yield* sql<{
							readonly id: string;
							readonly ordinal: number;
							readonly status: string;
							readonly active_attempt_id: string;
						}>`
							SELECT id, ordinal, status, active_attempt_id
							FROM session_turns WHERE session_id = 'session-1'
							ORDER BY ordinal
						`;
						const columns = yield* sql<{ readonly name: string }>`
							PRAGMA table_info(sessions)
						`;
						return {
							threads,
							session,
							turns,
							columns: columns.map((column) => column.name),
						};
					}),
				);
				expect(result.threads).toEqual([
					{
						id: "provider-thread:session:session-1:provider-thread%3Aprovider%3Aclaude%3Anative-thread%3Aclaude-session-abc",
						provider: "claude",
						native_thread_id: "claude-session-abc",
						native_head_id: "event-9",
						status: "idle",
					},
				]);
				expect(result.session).toEqual([
					{
						active_provider_thread_id:
							"provider-thread:session:session-1:provider-thread%3Aprovider%3Aclaude%3Anative-thread%3Aclaude-session-abc",
					},
				]);
				expect(result.turns).toEqual([
					{
						id: "turn_a",
						ordinal: 1,
						status: "completed",
						active_attempt_id: "attempt:turn:turn_a:ordinal:1",
					},
					{
						id: "turn_b",
						ordinal: 2,
						status: "failed",
						active_attempt_id: "attempt:turn:turn_b:ordinal:1",
					},
					{
						id: "turn_c",
						ordinal: 3,
						status: "running",
						active_attempt_id: "attempt:turn:turn_c:ordinal:1",
					},
				]);
				for (const retired of [
					"cursor",
					"resume_strategy",
					"provider_event_cursor",
					"current_turn_id",
					"current_turn_phase",
				]) {
					expect(result.columns).not.toContain(retired);
				}
				expect(result.columns).toContain("active_provider_thread_id");
			} finally {
				await currentRuntime.dispose();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
