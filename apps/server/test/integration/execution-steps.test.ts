import { AgentItemId, type MessageContent, SessionId } from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { readSessionTimelineSnapshot } from "../../../../packages/domain/src/queries/session-timeline-snapshot.ts";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";

it("persists native child lineage and physical root completion separately from child terminal status", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				const sessionId = SessionId.make(createSessionCommand.sessionId);
				yield* domain.dispatch({
					streamId: sessionId,
					commandId: "create",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					streamId: sessionId,
					commandId: "start",
					command: { _tag: "StartTurn", turnId: "turn", startedAt: 2 },
				});
				yield* sql`UPDATE session_turns SET active_attempt_id='attempt' WHERE id='turn'`;
				const persist = (id: string, content: MessageContent) =>
					domain.dispatch({
						streamId: sessionId,
						commandId: id,
						command: {
							_tag: "PersistMessage",
							messageId: id,
							turnId: "turn",
							role: "assistant",
							kind: content._tag,
							contentJson: JSON.stringify(content),
							parentItemId: null,
							createdAt: 3,
						},
					});
				yield* persist("spawn", {
					_tag: "tool_use",
					itemId: AgentItemId.make("spawn"),
					tool: "Agent",
					input: {},
					subagent: {
						childSessionId: "native-child",
						presentation: "detached",
					},
				});
				yield* persist("inner-tool", {
					_tag: "tool_use",
					itemId: AgentItemId.make("tool"),
					parentItemId: AgentItemId.make("spawn"),
					tool: "Bash",
					input: { command: "pwd" },
				});
				yield* persist("root-complete", {
					_tag: "subagent_progress",
					childId: "spawn",
					parentId: "spawn",
					childSessionId: "native-child",
					status: "running",
					rootCompleted: true,
					durationMs: 1,
					turns: 1,
					toolCalls: 1,
					tokens: 1,
					contextPercentage: 0,
					toolsUsed: ["Bash"],
					errorCount: 0,
				});
				let snapshot = yield* readSessionTimelineSnapshot(sql, sessionId);
				expect(snapshot.projection.executionSteps).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							kind: "subagent",
							status: "running",
							nativeChildId: "native-child",
							attemptId: "attempt",
							rootCompletedAt: 3,
						}),
						expect.objectContaining({
							kind: "tool",
							parentItemId: "spawn",
							status: "running",
						}),
					]),
				);
				yield* persist("spawn-result", {
					_tag: "tool_result",
					itemId: AgentItemId.make("spawn"),
					output: "child launched",
					isError: false,
				});
				expect(
					(yield* sql<{
						status: string;
					}>`SELECT status FROM session_execution_steps WHERE item_id='spawn'`)[0]
						?.status,
				).toBe("running");
				yield* persist("child-summary", {
					_tag: "subagent_summary",
					itemId: AgentItemId.make("spawn"),
					agentName: "Worker",
					model: "test",
					turns: 1,
					durationMs: 1,
					summary: "Done",
					isError: false,
					childSessionId: "native-child",
				});
				yield* domain.dispatch({
					streamId: sessionId,
					commandId: "finish",
					command: {
						_tag: "SettleTurn",
						turnId: "turn",
						outcome: "completed",
						settledAt: 4,
					},
				});
				snapshot = yield* readSessionTimelineSnapshot(sql, sessionId);
				expect(snapshot.projection.executionSteps).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ kind: "subagent", status: "completed" }),
						expect.objectContaining({ kind: "tool", status: "cancelled" }),
					]),
				);
				expect(snapshot.projection.activeTurn).toBeNull();
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
