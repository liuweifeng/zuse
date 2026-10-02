import type { CodexTurnEvidence } from "@zuse/agents/drivers/codex-thread-reader";
import {
	JobId,
	Message,
	MessageContent,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { makeJobWorker } from "@zuse/domain/agent-engine/job-worker";
import { type Job, JobRequest } from "@zuse/domain/agent-engine/jobs";
import { attemptIdFor } from "@zuse/domain/core/state";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Deferred, Effect, Exit, Fiber, PubSub, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { roleForContent } from "../../src/conversation/core/conversation-message-mapping.ts";
import type { ProviderJobExecutorOptions } from "../../src/conversation/core/provider-jobs.ts";
import {
	recoverProviderTurn,
	redactRecoveryContent,
} from "../../src/conversation/core/provider-turn-recovery.ts";
import { reconcileSessionRuntime } from "../../src/conversation/core/startup-recovery.ts";

const terminal: CodexTurnEvidence = {
	kind: "terminal",
	turn: {
		id: "native-turn",
		status: "completed",
		itemsView: "full",
		error: null,
		startedAt: 1,
		completedAt: 2,
		durationMs: 1000,
		items: [
			{
				type: "agentMessage",
				id: "answer",
				text: "Recovered Bearer secret-value",
				phase: "final_answer",
				memoryCitation: null,
			},
		],
	},
};

const fixture = Effect.gen(function* () {
	yield* createDomainTestSchema();
	const sql = yield* SqlClient.SqlClient;
	const domain = yield* makeSessionDomain(sql, () =>
		Effect.succeed(crypto.randomUUID()),
	);
	const sessionId = SessionId.make("session-1");
	const dispatch = (
		command: Parameters<typeof domain.dispatch>[0]["command"],
	) =>
		domain.dispatch({
			commandId: crypto.randomUUID(),
			streamId: sessionId,
			command,
		});
	yield* dispatch({ ...createSessionCommand, providerId: "codex" });
	yield* dispatch({ _tag: "StartTurn", turnId: "turn-1", startedAt: 1 });
	const source = attemptIdFor("turn-1", 1);
	yield* dispatch({
		_tag: "BindAttemptProviderTurn",
		turnId: "turn-1",
		attemptId: source,
		boundAt: 2,
		reference: {
			provider: "codex",
			nativeThreadId: "native-thread",
			nativeTurnId: "native-turn",
		},
	});
	const originalMessageId = MessageId.make(
		`provider:${source}:AssistantMessage:answer`,
	);
	yield* dispatch({
		_tag: "PersistMessage",
		messageId: originalMessageId,
		turnId: "turn-1",
		role: "assistant",
		kind: "assistant",
		contentJson: JSON.stringify({
			_tag: "assistant",
			itemId: "answer",
			text: "Partial",
			checkpoint: { revision: 1, final: false },
		}),
		parentItemId: null,
		checkpointRevision: 1,
		checkpointFinal: false,
		createdAt: 3,
	});
	const options: Pick<
		ProviderJobExecutorOptions,
		"sessionDomain" | "persistMessage" | "ndjsonAppend" | "settleTurn"
	> = {
		sessionDomain: domain,
		persistMessage: (id, content, messageId, turnId, expectedAttempt) =>
			Effect.gen(function* () {
				const mid = messageId ?? MessageId.make(crypto.randomUUID());
				const checkpoint =
					content._tag === "assistant" || content._tag === "thinking"
						? content.checkpoint
						: undefined;
				const receipt = yield* domain
					.dispatch({
						commandId: `message:persist:${mid}`,
						streamId: id,
						expectedAttempt,
						command: {
							_tag: "PersistMessage",
							messageId: mid,
							turnId,
							role: roleForContent(content),
							kind: content._tag,
							contentJson: JSON.stringify(content),
							parentItemId: null,
							checkpointRevision: checkpoint?.revision,
							checkpointFinal: checkpoint?.final,
							createdAt: 4,
						},
					})
					.pipe(
						Effect.catchTag("AttemptOwnershipConflict", Effect.fail),
						Effect.orDie,
					);
				return {
					message: Message.make({
						id: mid,
						sessionId: id,
						role: roleForContent(content),
						content,
						createdAt: new Date(4),
					}),
					sequence: 1,
					changed: receipt.eventIds.length > 0,
				};
			}),
		ndjsonAppend: () => Effect.void,
		settleTurn: (id, turnId, outcome, expectedAttempt) =>
			domain
				.dispatch({
					commandId: `settle:${expectedAttempt?.attemptId}`,
					streamId: id,
					expectedAttempt,
					command: { _tag: "SettleTurn", turnId, outcome, settledAt: 5 },
				})
				.pipe(Effect.asVoid, Effect.orDie),
	};
	yield* reconcileSessionRuntime(sql, domain);
	const rows = yield* sql<{
		id: string;
		request_json: string;
	}>`SELECT id, request_json FROM jobs WHERE kind = 'provider.turn.recover'`;
	expect(rows).toHaveLength(1);
	const row = rows[0];
	if (row === undefined) throw new Error("Recovery job missing");
	const job: Job = {
		id: JobId.make(row.id),
		sessionId,
		request: Schema.decodeUnknownSync(JobRequest)(JSON.parse(row.request_json)),
		sequence: 1,
		status: "running",
		attemptCount: 1,
		availableAt: "",
		leaseOwner: "test",
		leaseExpiresAt: null,
		causationEventId: null,
		correlationId: null,
		lastError: null,
		createdAt: "",
		updatedAt: "",
		completedAt: null,
	};
	return { sql, domain, dispatch, job, options, originalMessageId };
});
const run = <A, E>(
	program: Effect.Effect<
		A,
		E,
		SqlClient.SqlClient | import("effect").Scope.Scope
	>,
) =>
	Effect.runPromise(
		Effect.scoped(program).pipe(
			Effect.provide(sqliteLayer({ filename: ":memory:" })),
		),
	);

test("restart enqueues read-only recovery and replaces partial output with redacted final content exactly once", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, domain, job, options, originalMessageId } = yield* fixture;
			let reads = 0;
			const inspect = () =>
				Effect.sync(() => {
					reads++;
					return terminal;
				});
			yield* recoverProviderTurn(job, options, inspect);
			yield* recoverProviderTurn(job, options, inspect);
			expect(reads).toBe(1);
			const rows = yield* sql<{
				id: string;
				content_json: string;
			}>`SELECT id, content_json FROM messages`;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe(originalMessageId);
			expect(JSON.parse(rows[0]?.content_json ?? "null")).toMatchObject({
				text: "Recovered Bearer [REDACTED]",
				checkpoint: { final: true },
			});
			expect(yield* domain.activeAttempt("session-1")).toBeNull();
			const sends =
				yield* sql`SELECT 1 FROM jobs WHERE kind = 'provider.turn.send'`;
			expect(sends).toHaveLength(0);
		}),
	);
});

test.each([
	"missing",
	"incomplete",
	"running",
] as const)("%s evidence produces explicit uncertainty without a resend", async (kind) => {
	await run(
		Effect.gen(function* () {
			const { sql, job, options } = yield* fixture;
			yield* recoverProviderTurn(job, options, () => Effect.succeed({ kind }));
			const rows = yield* sql<{
				status: string;
			}>`SELECT status FROM session_attempts WHERE reason = 'provider_recovery'`;
			expect(rows[0]?.status).toBe("failed");
			expect(
				yield* sql`SELECT 1 FROM jobs WHERE kind = 'provider.turn.send'`,
			).toHaveLength(0);
		}),
	);
});

test("a retry during inspection revokes recovery writes", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, job, options, dispatch } = yield* fixture;
			const result = yield* Effect.exit(
				recoverProviderTurn(job, options, () =>
					dispatch({
						_tag: "RetryTurn",
						turnId: "turn-1",
						reason: "retry",
						requestedAt: 5,
						providerInputJson: "{}",
					}).pipe(Effect.as(terminal)),
				),
			);
			expect(Exit.isFailure(result)).toBe(true);
			const rows = yield* sql<{
				content_json: string;
			}>`SELECT content_json FROM messages`;
			expect(JSON.parse(rows[0]?.content_json ?? "null").text).toBe("Partial");
		}),
	);
});

test("redaction preserves long transcript text and scrubs nested credential values", () => {
	const content = Schema.decodeUnknownSync(MessageContent)({
		_tag: "tool_use",
		itemId: "tool",
		tool: "HTTP",
		input: {
			password: "private",
			body: "x".repeat(9000),
			header: "Bearer credential",
		},
	});
	expect(redactRecoveryContent(content)).toMatchObject({
		input: {
			password: "[REDACTED]",
			body: "x".repeat(9000),
			header: "Bearer [REDACTED]",
		},
	});
});

test("an unavailable transcript never persists raw transport credentials", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, job, options } = yield* fixture;
			yield* recoverProviderTurn(job, options, () =>
				Effect.fail(new Error("Bearer private-provider-token")),
			);
			const rows = yield* sql<{
				content_json: string;
			}>`SELECT content_json FROM messages WHERE kind = 'error'`;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.content_json).not.toContain("private-provider-token");
		}),
	);
});

test("a second engine restart retains the pending recovery without enqueuing a send", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, domain, job, options } = yield* fixture;
			yield* reconcileSessionRuntime(sql, domain);
			expect(
				yield* sql`SELECT 1 FROM jobs WHERE kind = 'provider.turn.recover'`,
			).toHaveLength(1);
			yield* recoverProviderTurn(job, options, () => Effect.succeed(terminal));
			expect(yield* domain.activeAttempt("session-1")).toBeNull();
		}),
	);
});

test("Stop during native inspection cancels recovery and rejects its final output", async () => {
	await run(
		Effect.gen(function* () {
			const { sql, job, options, dispatch } = yield* fixture;
			const result = yield* Effect.exit(
				recoverProviderTurn(job, options, () =>
					dispatch({ _tag: "RequestTurnInterrupt", requestedAt: 5 }).pipe(
						Effect.as(terminal),
					),
				),
			);
			expect(Exit.isFailure(result)).toBe(true);
			const rows = yield* sql<{
				content_json: string;
			}>`SELECT content_json FROM messages`;
			expect(rows).toHaveLength(1);
			expect(JSON.parse(rows[0]?.content_json ?? "null").text).toBe("Partial");
			const jobs = yield* sql<{
				kind: string;
				status: string;
			}>`SELECT kind, status FROM jobs ORDER BY sequence`;
			expect(jobs).toEqual([
				{ kind: "provider.turn.recover", status: "cancelled" },
				{ kind: "provider.turn.interrupt", status: "pending" },
			]);
			const turns = yield* sql<{
				status: string;
				phase: string;
			}>`SELECT status, phase FROM session_turns`;
			expect(turns[0]?.phase).toBe("interrupt-requested");
			expect(turns[0]?.status).not.toBe("completed");
		}),
	);
});

test("committed Stop interrupts an in-flight recovery worker without waiting for provider inspection", async () => {
	await run(
		Effect.gen(function* () {
			const { domain, options, dispatch, job } = yield* fixture;
			const started = yield* Deferred.make<void>();
			const stopped = yield* Deferred.make<void>();
			const notifications = yield* PubSub.subscribe(domain.jobCancellations);
			const worker = yield* makeJobWorker({
				ledger: domain.jobs,
				workerId: "recovery-cancel-test",
				execute: (claimed) =>
					claimed.request._tag === "provider.turn.recover"
						? recoverProviderTurn(claimed, options, () =>
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.ensuring(Deferred.succeed(stopped, undefined)),
								),
							).pipe(Effect.orDie)
						: Effect.void,
			});
			const drain = yield* Effect.forkChild(worker.drainSession("session-1"));
			yield* Deferred.await(started);
			yield* dispatch({ _tag: "RequestTurnInterrupt", requestedAt: 6 });
			const cancelled = yield* PubSub.take(notifications);
			expect(cancelled).toEqual([job.id]);
			expect((yield* domain.jobs.get(job.id))?.status).toBe("cancelled");
			yield* worker.cancel(cancelled);
			yield* Deferred.await(stopped);
			yield* Fiber.join(drain);
		}),
	);
});
