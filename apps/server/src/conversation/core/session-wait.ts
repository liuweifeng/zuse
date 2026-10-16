import {
	AgentTurnId,
	AttemptId,
	MessageId,
	SessionWaitError,
	type SessionWaitInput,
	type SessionWaitResult,
} from "@zuse/contracts";
import { joinId } from "@zuse/domain/agent-engine/ids";
import { attemptIdFor } from "@zuse/domain/core/state";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect, Fiber, Option, Stream } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { observeSessionRuntime } from "./session-liveness.ts";

const terminal = new Set([
	"completed",
	"interrupted",
	"failed",
	"cancelled",
	"rolled_back",
]);
export const boundedWaitTimeout = (value?: number): number =>
	typeof value === "number" && Number.isFinite(value)
		? Math.max(1, Math.min(300_000, Math.floor(value)))
		: 30_000;

/** One replayable stream closes the snapshot/subscription gap; no provider work is owned by a waiter. */
export const makeSessionWait =
	(
		sql: SqlClient.SqlClient,
		domain: Pick<SessionDomainApi, "events" | "currentSequence">,
	) =>
	(
		input: SessionWaitInput,
	): Effect.Effect<SessionWaitResult, SessionWaitError> =>
		Effect.gen(function* () {
			const deadline = Date.now() + boundedWaitTimeout(input.timeoutMs);
			const pinned = yield* sql.withTransaction(
				Effect.gen(function* () {
					const sessions =
						yield* sql`SELECT id FROM sessions WHERE id=${input.sessionId}`;
					if (sessions.length === 0)
						return yield* new SessionWaitError({
							message: "Session was not found.",
						});
					const rows = yield* sql<{
						id: string;
						active_attempt_id: string;
					}>`SELECT t.id,t.active_attempt_id FROM session_turns t WHERE t.session_id=${input.sessionId} AND (${input.turnId ?? null} IS NULL OR t.id=${input.turnId ?? null}) AND (${input.attemptId ?? null} IS NULL OR EXISTS(SELECT 1 FROM session_attempts a WHERE a.session_id=t.session_id AND a.turn_id=t.id AND a.id=${input.attemptId ?? null})) ORDER BY t.ordinal DESC LIMIT 1`;
					if (
						rows[0] === undefined &&
						(input.turnId !== undefined || input.attemptId !== undefined)
					)
						return yield* new SessionWaitError({
							message: "Requested execution was not found in this session.",
						});
					return {
						turnId: rows[0] === undefined ? null : AgentTurnId.make(rows[0].id),
						attemptId:
							input.attemptId ??
							(rows[0] === undefined
								? null
								: AttemptId.make(rows[0].active_attempt_id)),
						sequence: yield* domain.currentSequence,
					};
				}),
			);
			const result = (
				outcome: SessionWaitResult["outcome"],
				status: string,
			): SessionWaitResult => ({
				sessionId: input.sessionId,
				turnId: pinned.turnId,
				attemptId: pinned.attemptId,
				target: input.target,
				outcome,
				status,
			});
			const observe = sql.withTransaction(
				Effect.gen(function* () {
					const sessions =
						yield* sql`SELECT id FROM sessions WHERE id=${input.sessionId}`;
					if (sessions.length === 0) return result("deleted", "deleted");
					if (pinned.turnId === null) {
						const later =
							yield* sql`SELECT id FROM session_turns WHERE session_id=${input.sessionId} LIMIT 1`;
						if (later.length > 0) return result("superseded", "changed");
						const runtime = yield* observeSessionRuntime(sql, input.sessionId);
						if (input.target === runtime.state)
							return result("reached", runtime.state);
						return result("no-turn", runtime.state);
					}
					const rows = yield* sql<{
						status: string;
						active_attempt_id: string;
						ordinal: number;
					}>`SELECT status,active_attempt_id,ordinal FROM session_turns WHERE session_id=${input.sessionId} AND id=${pinned.turnId}`;
					const turn = rows[0];
					if (turn === undefined) return result("deleted", "deleted");
					if (turn.active_attempt_id !== pinned.attemptId)
						return result("superseded", turn.status);
					if (input.target === "done" && terminal.has(turn.status))
						return result("reached", turn.status);
					const newer =
						yield* sql`SELECT id FROM session_turns WHERE session_id=${input.sessionId} AND ordinal>${turn.ordinal} LIMIT 1`;
					if (newer.length > 0) return result("superseded", turn.status);
					const runtime = yield* observeSessionRuntime(sql, input.sessionId);
					if (
						input.target === "blocked" &&
						runtime.state === "blocked" &&
						runtime.attemptId === pinned.attemptId
					)
						return result("reached", turn.status);
					if (
						input.target === "idle" &&
						terminal.has(turn.status) &&
						runtime.state === "idle"
					)
						return result("reached", turn.status);
					if (terminal.has(turn.status)) return result("terminal", turn.status);
					return null;
				}),
			);
			const resolved = yield* Stream.concat(
				Stream.succeed(null),
				domain.events({
					streamId: input.sessionId,
					afterSequence: pinned.sequence,
				}),
			).pipe(
				Stream.mapEffect(() => observe),
				Stream.filter((value): value is SessionWaitResult => value !== null),
				Stream.runHead,
				Effect.timeoutOption(Math.max(1, deadline - Date.now())),
			);
			return Option.isSome(resolved) && Option.isSome(resolved.value)
				? resolved.value.value
				: result("timeout", "pending");
		}).pipe(
			Effect.mapError((error) =>
				error._tag === "SessionWaitError"
					? error
					: new SessionWaitError({
							message: "Could not observe the requested execution.",
						}),
			),
		);

/** Stable execution identities are selected before admission, never by observing the latest turn afterward. */
export const makeSessionWaitOperations = (options: {
	readonly sql: SqlClient.SqlClient;
	readonly domain: Pick<SessionDomainApi, "events" | "currentSequence">;
	readonly scope: import("effect").Scope.Scope;
	readonly send: import("../services/conversation-services.ts").ConversationOperations["sendMessageWithInput"];
}) => {
	const waitSession = makeSessionWait(options.sql, options.domain);
	const sendMessageAndWait: import("../services/conversation-services.ts").ConversationOperations["sendMessageAndWait"] =
		(input, wait) =>
			Effect.gen(function* () {
				const turnId = AgentTurnId.make(
					joinId("send-and-wait", input.commandId),
				);
				const attemptId = AttemptId.make(attemptIdFor(turnId, 1));
				const deadline = Date.now() + boundedWaitTimeout(wait.timeoutMs);

				const submission = yield* options
					.send({
						...input,
						asGoal: false,
						turnId,
						messageId: MessageId.make(
							joinId("send-and-wait-message", input.commandId),
						),
					})
					.pipe(Effect.forkIn(options.scope));
				const admitted = yield* Fiber.join(submission).pipe(
					Effect.timeoutOption(Math.max(1, deadline - Date.now())),
				);
				if (Option.isNone(admitted))
					return {
						sessionId: input.sessionId,
						turnId,
						attemptId,
						target: wait.target,
						outcome: "timeout" as const,
						status: "pending",
					};
				if (!admitted.value.accepted || admitted.value.turnId !== turnId)
					return yield* new SessionWaitError({
						message: "The message did not admit the expected execution.",
					});
				return yield* waitSession({
					sessionId: input.sessionId,
					turnId,
					attemptId,
					target: wait.target,
					timeoutMs: Math.max(1, deadline - Date.now()),
				});
			}).pipe(
				Effect.mapError((error) =>
					error._tag === "SessionWaitError"
						? error
						: new SessionWaitError({
								message: "Could not submit the requested message.",
							}),
				),
			);
	return { waitSession, sendMessageAndWait };
};
