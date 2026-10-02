import {
	type AgentSessionNotFoundError,
	AgentTurnId,
	AttemptId,
	type MessageContent,
	MessageId,
	SessionId,
	type SessionStartError,
} from "@zuse/contracts";
import type {
	JobExecutionFailure,
	JobExecutor,
	JobRetry,
} from "@zuse/domain/agent-engine/job-worker";
import type { Job, JobRequest } from "@zuse/domain/agent-engine/jobs";
import { attemptIdFor } from "@zuse/domain/core/state";
import type {
	AttemptOwnership,
	AttemptOwnershipConflict,
} from "@zuse/domain/engine/dispatch";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Cause, Effect } from "effect";
import { isProviderAuthenticationRequired } from "../../provider/provider-auth-failure.ts";
import type { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import type { OpenProviderSessionOptions } from "./provider-session-runtime.ts";
import { recoverProviderTurn } from "./provider-turn-recovery.ts";
import {
	decodeProviderModelOptions,
	decodeProviderStartRequest,
	decodeProviderTurnInput,
} from "./provider-turn-request.ts";

/**
 * Executes provider jobs from the durable ledger.
 *
 * Handlers re-read durable state before acting. Provider sends retain a durable
 * delivery fence across crashes; uncertain delivery requires explicit retry.
 * Handlers report
 * failures as `JobExecutionFailure`; the worker decides whether to retry.
 */

const PROVIDER_DELIVERY_OUTCOME_UNKNOWN =
	"Zuse could not confirm whether the agent received this message before the runtime stopped. Zuse did not send it again to avoid a duplicate. Retry the message if no response appears.";

const isProvenUndeliveredProviderSend = (
	cause: Cause.Cause<AgentSessionNotFoundError>,
): boolean => {
	const reason = cause.reasons[0];
	return (
		cause.reasons.length === 1 &&
		reason !== undefined &&
		Cause.isFailReason(reason) &&
		reason.error._tag === "AgentSessionNotFoundError"
	);
};

const failure = (
	message: string,
	options: { readonly retry: JobRetry; readonly cause?: unknown },
): JobExecutionFailure => ({
	message,
	retry: options.retry,
	cause: options.cause ?? new Error(message),
});

export interface ProviderJobExecutorOptions {
	readonly delivery: ReturnType<typeof makeReactorEffectJournal>;
	readonly getSession: ConversationOperations["getSession"];
	readonly ensureForTurn: (
		sessionId: SessionId,
		options?: OpenProviderSessionOptions,
	) => Effect.Effect<boolean, SessionStartError>;
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
		idOverride: MessageId | undefined,
		turnIdOverride: AgentTurnId,
		ownership: AttemptOwnership,
	) => Effect.Effect<PersistedMessage, AttemptOwnershipConflict>;
	readonly ndjsonAppend: (
		sessionId: SessionId,
		persisted: PersistedMessage,
	) => Effect.Effect<void>;
	readonly setStatus: (
		sessionId: SessionId,
		status: "idle" | "running" | "error",
		ownership: AttemptOwnership,
	) => Effect.Effect<void, AttemptOwnershipConflict>;
	readonly getProviderStartJson: (
		sessionId: SessionId,
	) => Effect.Effect<string | null>;
	readonly settleTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		outcome: "completed" | "interrupted" | "error",
		expectedAttempt?: AttemptOwnership,
	) => Effect.Effect<void>;
	readonly rememberActiveTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
	) => void;
	readonly provider: ProviderServiceShape;
	readonly sessionDomain: Pick<SessionDomainApi, "dispatch" | "activeAttempt">;
}

type RequestOf<Tag extends JobRequest["_tag"]> = Extract<
	JobRequest,
	{ readonly _tag: Tag }
>;

export const makeProviderJobExecutor = (
	options: ProviderJobExecutorOptions,
): JobExecutor => {
	const {
		delivery,
		getSession: lookupSession,
		ensureForTurn,
		persistMessage,
		ndjsonAppend,
		setStatus,
		getProviderStartJson,
		settleTurn,
		rememberActiveTurn,
		provider,
		sessionDomain,
	} = options;

	const recoverUnknownDelivery = (
		job: Job,
		sessionId: SessionId,
		turnId: AgentTurnId,
		expectedAttempt: AttemptOwnership,
	) =>
		Effect.gen(function* () {
			const recovering = yield* sessionDomain
				.dispatch({
					commandId: `${job.id}:recover`,
					streamId: sessionId,
					expectedAttempt,
					command: {
						_tag: "RecoverTurn",
						turnId,
						expectedAttemptId: expectedAttempt.attemptId,
						requestedAt: Date.now(),
					},
				})
				.pipe(
					Effect.as(true),
					Effect.catchTag("ValidationFailed", () => Effect.succeed(false)),
					Effect.catch((error) =>
						error._tag === "AttemptOwnershipConflict"
							? Effect.fail(error)
							: Effect.die(error),
					),
				);
			if (recovering) {
				yield* delivery.markOutcomeUnknown(job.id);
				return;
			}

			yield* persistMessage(
				sessionId,
				{ _tag: "error", message: PROVIDER_DELIVERY_OUTCOME_UNKNOWN },
				MessageId.make(`provider-outcome-unknown:${job.id}`),
				turnId,
				expectedAttempt,
			);
			yield* settleTurn(sessionId, turnId, "error", expectedAttempt);
			yield* delivery.markOutcomeUnknown(job.id);
		});

	const providerStop = (job: Job, request: RequestOf<"provider.stop">) =>
		Effect.gen(function* () {
			const sessionId = SessionId.make(job.sessionId);
			yield* provider
				.close(sessionId, undefined, request.providerSessionId ?? null)
				.pipe(Effect.catch(() => Effect.void));
			yield* sessionDomain
				.dispatch({
					commandId: `${job.id}:detach`,
					streamId: sessionId,
					command: {
						_tag: "DetachProvider",
						expectedProviderSessionId: request.providerSessionId ?? null,
						detachedAt: request.requestedAt,
					},
				})
				.pipe(Effect.orDie);
		});

	const providerTurnSend = (
		job: Job,
		request: RequestOf<"provider.turn.send">,
	) =>
		Effect.gen(function* () {
			const sessionId = SessionId.make(job.sessionId);
			const turnId = AgentTurnId.make(request.turnId);
			const expectedAttempt = {
				turnId,
				attemptId: request.attemptId ?? attemptIdFor(turnId, 1),
			};
			const session = yield* lookupSession(sessionId).pipe(
				Effect.catch(() => Effect.succeed(null)),
			);
			const activeAttempt = yield* sessionDomain
				.activeAttempt(sessionId)
				.pipe(Effect.orDie);
			// The turn settled, was superseded, or its session was archived or
			// deleted while this job waited. Nothing to send.
			if (
				session === null ||
				session.archivedAt !== null ||
				activeAttempt?.turnId !== turnId ||
				activeAttempt.attemptId !== expectedAttempt.attemptId
			) {
				return;
			}
			const input = yield* decodeProviderTurnInput(
				request.providerInputJson,
			).pipe(Effect.orDie);
			const providerStartJson =
				request.providerStartJson ?? (yield* getProviderStartJson(sessionId));
			const startupRequest =
				providerStartJson === null
					? null
					: yield* decodeProviderStartRequest(providerStartJson).pipe(
							Effect.orDie,
						);
			const startupModelOptions =
				startupRequest?.modelOptionsJson == null
					? undefined
					: yield* decodeProviderModelOptions(
							startupRequest.modelOptionsJson,
						).pipe(Effect.orDie);
			const deliveryState = yield* delivery.begin(job.id);
			if (deliveryState === "completed" || deliveryState === "outcome-unknown")
				return;
			if (deliveryState === "already-started") {
				yield* recoverUnknownDelivery(job, sessionId, turnId, expectedAttempt);
				return;
			}
			// A provider may finish before send returns. Publish running before sending.
			yield* setStatus(sessionId, "running", expectedAttempt);

			const sent = yield* provider
				.send(
					sessionId,
					turnId,
					input.text,
					input.attachments,
					input.fileRefs,
					input.skillRefs,
					AttemptId.make(expectedAttempt.attemptId),
				)
				.pipe(Effect.exit);
			if (sent._tag === "Success") {
				yield* delivery.complete(job.id);
				return;
			}
			if (!isProvenUndeliveredProviderSend(sent.cause)) {
				yield* recoverUnknownDelivery(job, sessionId, turnId, expectedAttempt);
				return;
			}
			const restarted = yield* ensureForTurn(sessionId, {
				initialTurnId: turnId,
				initialAttemptId: AttemptId.make(expectedAttempt.attemptId),
				modelOptions: startupModelOptions,
				enableSubagents: startupRequest?.enableSubagents,
				forkFromResume: startupRequest?.forkFromResume,
				postBootStatus: "running",
				sendAfterOpen: {
					turnId,
					attemptId: AttemptId.make(expectedAttempt.attemptId),
					text: input.text,
					attachments: input.attachments,
					fileRefs: input.fileRefs,
					skillRefs: input.skillRefs,
				},
			}).pipe(
				Effect.match({
					onFailure: (error) => ({ ok: false as const, error }),
					onSuccess: (started) => ({ ok: started, error: null }),
				}),
			);
			if (restarted.ok) {
				yield* delivery.complete(job.id);
				return;
			}
			// A close or switch invalidated this startup while it awaited the
			// provider. The newer lifecycle owner is responsible for settlement.
			if (restarted.error === null) return;
			const persistedError = yield* persistMessage(
				sessionId,
				{
					_tag: "error",
					message: restarted.error.reason,
				},
				undefined,
				turnId,
				expectedAttempt,
			);
			yield* ndjsonAppend(sessionId, persistedError);
			// Keep the durable turn active. Explicit Retry and boot recovery replay
			// this exact provider request without reconstructing user input.
			yield* setStatus(sessionId, "error", expectedAttempt);
			// Authentication is recoverable only through explicit resume, which
			// replays this same durable turn; the job is done. Other failures park
			// the job so the user's next action or boot recovery tries again.
			if (isProviderAuthenticationRequired(restarted.error.reason)) {
				yield* delivery.complete(job.id);
				return;
			}
			yield* delivery.releaseUndelivered(job.id);
			return yield* Effect.fail(
				failure(
					`Provider turn could not be started after durable intent: ${restarted.error.reason}`,
					{ retry: "on_demand", cause: restarted.error },
				),
			);
		});

	const providerTurnInterrupt = (
		job: Job,
		request: RequestOf<"provider.turn.interrupt">,
	) =>
		Effect.gen(function* () {
			const sessionId = SessionId.make(job.sessionId);
			const turnId = AgentTurnId.make(request.turnId);
			const expectedAttempt = {
				turnId,
				attemptId: request.attemptId ?? attemptIdFor(turnId, 1),
			};
			const session = yield* lookupSession(sessionId).pipe(
				Effect.catch(() => Effect.succeed(null)),
			);
			const activeAttempt = yield* sessionDomain
				.activeAttempt(sessionId)
				.pipe(Effect.orDie);
			if (
				session === null ||
				session.archivedAt !== null ||
				activeAttempt?.turnId !== turnId ||
				activeAttempt.attemptId !== expectedAttempt.attemptId
			)
				return;

			const interrupted = yield* provider
				.interrupt(sessionId, turnId, AttemptId.make(expectedAttempt.attemptId))
				.pipe(Effect.timeout("5 seconds"), Effect.exit);
			if (interrupted._tag === "Success") {
				if (
					!(yield* sessionDomain
						.dispatch({
							commandId: `${job.id}:acknowledged`,
							expectedAttempt,
							streamId: sessionId,
							command: {
								_tag: "AcknowledgeTurnInterrupt",
								turnId,
								acknowledgedAt: Date.now(),
							},
						})
						.pipe(
							Effect.as(true),
							Effect.catchTag("AttemptOwnershipConflict", () =>
								Effect.succeed(false),
							),
							Effect.orDie,
						))
				)
					return;
				yield* settleTurn(sessionId, turnId, "interrupted", expectedAttempt);
				return;
			}
			if (
				!(yield* sessionDomain
					.dispatch({
						commandId: `${job.id}:failed`,
						expectedAttempt,
						streamId: sessionId,
						command: {
							_tag: "FailTurnInterrupt",
							turnId,
							reason: "Provider did not acknowledge cancellation",
							failedAt: Date.now(),
						},
					})
					.pipe(
						Effect.as(true),
						Effect.catchTag("AttemptOwnershipConflict", () =>
							Effect.succeed(false),
						),
						Effect.orDie,
					))
			)
				return;
			if (
				!(yield* sessionDomain
					.dispatch({
						commandId: `${job.id}:settled`,
						expectedAttempt,
						streamId: sessionId,
						command: {
							_tag: "SettleTurn",
							turnId,
							outcome: "interrupted",
							settledAt: Date.now(),
						},
					})
					.pipe(
						Effect.as(true),
						Effect.catchTag("AttemptOwnershipConflict", () =>
							Effect.succeed(false),
						),
						Effect.orDie,
					))
			)
				return;
			yield* provider
				.close(sessionId, {
					turnId,
					attemptId: AttemptId.make(expectedAttempt.attemptId),
				})
				.pipe(Effect.ignore);
		});

	const providerSuccessorStart = (
		job: Job,
		request: RequestOf<"provider.successor.start">,
	) =>
		Effect.gen(function* () {
			const sessionId = SessionId.make(job.sessionId);
			const input = yield* decodeProviderTurnInput(request.inputJson).pipe(
				Effect.orDie,
			);
			const hasRich =
				input.attachments.length > 0 ||
				input.fileRefs.length > 0 ||
				input.skillRefs.length > 0 ||
				(input.annotations?.length ?? 0) > 0;
			const content = hasRich
				? {
						_tag: "user_rich" as const,
						text: input.text,
						attachments: input.attachments,
						fileRefs: input.fileRefs,
						skillRefs: input.skillRefs,
						annotations: input.annotations ?? [],
						goal: false,
					}
				: { _tag: "user" as const, text: input.text, goal: false };
			const admitted = yield* sessionDomain
				.dispatch({
					commandId: `${job.id}:submit`,
					streamId: sessionId,
					command: {
						_tag: "SubmitTurn",
						turnId: request.turnId,
						messageId: `queued_${request.queueId}`,
						role: "user",
						kind: content._tag,
						contentJson: JSON.stringify(content),
						parentItemId: null,
						providerInputJson: request.inputJson,
						createdAt: Date.now(),
					},
				})
				.pipe(
					Effect.as(true),
					Effect.catchTag("TurnAlreadyRunning", () =>
						sessionDomain
							.dispatch({
								commandId: `${job.id}:requeue`,
								streamId: sessionId,
								command: {
									_tag: "EnqueueTurn",
									queueId: request.queueId,
									inputJson: request.inputJson,
									position: 0,
									createdAt: Date.now(),
									ready: true,
								},
							})
							.pipe(Effect.as(false)),
					),
				)
				.pipe(Effect.orDie);
			if (admitted) {
				rememberActiveTurn(sessionId, AgentTurnId.make(request.turnId));
			}
		});

	return (job) => {
		const request = job.request;
		switch (request._tag) {
			case "provider.stop":
				return providerStop(job, request);
			case "provider.turn.recover":
				return recoverProviderTurn(job, options).pipe(
					Effect.catchTag("AttemptOwnershipConflict", () => Effect.void),
					Effect.mapError(() =>
						failure("Native recovery failed", { retry: "on_demand" }),
					),
				);
			case "provider.turn.send":
				return providerTurnSend(job, request).pipe(
					Effect.catchTag("AttemptOwnershipConflict", () => Effect.void),
				);
			case "provider.turn.interrupt":
				return providerTurnInterrupt(job, request);
			case "provider.successor.start":
				return providerSuccessorStart(job, request);
		}
	};
};
