import { AgentItemId, type MessageContent, SessionId } from "@zuse/contracts";
import { SessionEvent } from "@zuse/domain/core/events";
import { attemptIdFor } from "@zuse/domain/core/state";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { timelineEventFromDomain } from "../../../../packages/domain/src/projectors/timeline-projection.ts";
import {
	applyTimelineEvent,
	emptyTimelineProjection,
} from "../../../../packages/domain/src/projectors/timeline-reducer.ts";
import { readSessionTimelineSnapshot } from "../../../../packages/domain/src/queries/session-timeline-snapshot.ts";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { Migration0082ExecutionSteps } from "../../src/persistence/migrations/0082_execution_steps.ts";

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
							attemptId: attemptIdFor("turn", 1),
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
				const records = yield* sql<{
					payload_json: string;
				}>`SELECT payload_json FROM events WHERE stream_id=${sessionId} ORDER BY sequence`;
				let live = emptyTimelineProjection();
				for (const row of records)
					live = applyTimelineEvent(
						live,
						timelineEventFromDomain(
							sessionId,
							Schema.decodeUnknownSync(Schema.fromJsonString(SessionEvent))(
								row.payload_json,
							),
						),
					);
				expect(live.executionSteps).toEqual(snapshot.projection.executionSteps);
				yield* sql`DROP TABLE session_execution_steps`;
				yield* Migration0082ExecutionSteps;
				const upgraded = yield* readSessionTimelineSnapshot(sql, sessionId);
				expect(upgraded.projection.executionSteps).toEqual(
					snapshot.projection.executionSteps,
				);
				yield* domain.dispatch({
					streamId: sessionId,
					commandId: "rollback",
					command: {
						_tag: "RollbackTurns",
						throughOrdinal: 0,
						messageSequence: 0,
						removedMessageIds: snapshot.projection.messages.map(
							(message) => message.id,
						),
						rolledBackAt: 5,
					},
				});
				const rollbackSnapshot = yield* readSessionTimelineSnapshot(
					sql,
					sessionId,
				);
				const rollbackRecords = yield* sql<{
					payload_json: string;
				}>`SELECT payload_json FROM events WHERE stream_id=${sessionId} ORDER BY sequence`;
				let rollbackLive = emptyTimelineProjection();
				for (const row of rollbackRecords)
					rollbackLive = applyTimelineEvent(
						rollbackLive,
						timelineEventFromDomain(
							sessionId,
							Schema.decodeUnknownSync(Schema.fromJsonString(SessionEvent))(
								row.payload_json,
							),
						),
					);
				expect(rollbackLive.executionSteps).toEqual(
					rollbackSnapshot.projection.executionSteps,
				);
				expect(
					rollbackLive.executionSteps?.every(
						(step) => step.status === "cancelled" && step.updatedAt === 5,
					),
				).toBe(true);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
