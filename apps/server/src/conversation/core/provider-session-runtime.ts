import {
	type AgentTurnId,
	type AttachmentRef,
	type MessageContent,
	type MessageId,
	type Session,
	type SessionId,
	SessionStartError,
	type WorktreeId,
} from "@zuse/contracts";
import type {
	AttemptOwnershipConflict,
	ProviderSessionOwnershipConflict,
} from "@zuse/domain/engine/dispatch";
import type { WorktreeServiceShape } from "@zuse/git/worktree-service";
import { Effect, Exit, Option } from "effect";
import type { ConfigStoreServiceShape } from "../../config-store/services/config-store-service.ts";
import type { ModelCatalogServiceShape } from "../../model-catalog/services/model-catalog-service.ts";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import { RuntimeGitExecution } from "../../provider/services/runtime-git-execution.ts";
import type {
	ConversationOperations,
	CreateChatInput,
	CreateSessionInput,
} from "../services/conversation-services.ts";
import { WorkspaceExecutionPolicy } from "../services/workspace-execution-policy.ts";
import { formatProviderFailure } from "./conversation-input.ts";
import { makeConversationOrchestration } from "./conversation-orchestration.ts";
import type { ConversationStateApi } from "./conversation-state.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import type { IngestionLeaseIdentity } from "./ingestion-lease.ts";
import { dispatchReservedRuntimeCommand } from "./runtime-command.ts";

export interface OpenProviderSessionOptions {
	readonly initialPrompt?: string;
	readonly initialTurnId?: AgentTurnId;
	readonly initialAttemptId?: import("@zuse/contracts").AttemptId;
	readonly modelOptions?: Readonly<Record<string, string>>;
	readonly enableSubagents?: boolean;
	readonly forkFromResume?: boolean;
	readonly postBootStatus?: Session["status"];
	readonly sendAfterOpen?: {
		readonly turnId: AgentTurnId;
		readonly attemptId?: import("@zuse/contracts").AttemptId;
		readonly text: string;
		readonly attachments: ReadonlyArray<AttachmentRef>;
		readonly fileRefs?: ReadonlyArray<import("@zuse/contracts").FileRef>;
		readonly skillRefs?: ReadonlyArray<import("@zuse/contracts").SkillRef>;
	};
}

export interface ProviderSessionRuntimeOptions {
	readonly awaitWorkspaceReady?: Effect.Effect<void>;
	readonly state: ConversationStateApi;
	readonly sessionDomain: Pick<
		import("@zuse/domain/engine/session-domain").SessionDomainApi,
		"activeAttempt" | "dispatch" | "providerReservation"
	>;
	readonly agentsFor: (
		sessionId: SessionId,
	) => ReturnType<ConversationStateApi["agents"]>;
	readonly cwdForWorktree: (
		worktreeId: WorktreeId | null,
	) => Effect.Effect<string | undefined>;
	readonly runtime: Parameters<
		typeof makeConversationOrchestration
	>[0]["runtime"];
	readonly configStore: ConfigStoreServiceShape;
	readonly modelCatalog: ModelCatalogServiceShape;
	readonly worktrees: WorktreeServiceShape;
	readonly createChat: (
		input: CreateChatInput,
	) => ReturnType<ConversationOperations["createChat"]>;
	readonly createSession: (
		input: CreateSessionInput,
	) => ReturnType<ConversationOperations["createSession"]>;
	readonly getChat: ConversationOperations["getChat"];
	readonly getSession: ConversationOperations["getSession"];
	readonly sendMessage: ConversationOperations["sendMessage"];
	readonly listMessages: ConversationOperations["listMessages"];
	readonly listChats: ConversationOperations["listChats"];
	readonly listSessions: ConversationOperations["listSessions"];
	/**
	 * Timeline append used by display tools — `emit_ui` persists its
	 * validated `ui_spec` block here so it streams to the transcript
	 * like any other message.
	 */
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
		idOverride?: MessageId,
		turnIdOverride?: AgentTurnId,
	) => Effect.Effect<PersistedMessage>;
	readonly provider: ProviderServiceShape;
	readonly startSubscription: (
		sessionId: SessionId,
		identity?: IngestionLeaseIdentity,
	) => Effect.Effect<void>;
}

export const makeProviderSessionRuntime = (
	options: ProviderSessionRuntimeOptions,
) => {
	const awaitWorkspaceReady =
		options.awaitWorkspaceReady ??
		Effect.flatMap(WorkspaceExecutionPolicy, (policy) => policy.awaitReady);
	const {
		state,
		sessionDomain: optionsState,
		agentsFor,
		cwdForWorktree,
		runtime,
		configStore,
		modelCatalog,
		worktrees,
		createChat,
		createSession,
		getChat: lookupChat,
		getSession: lookupSession,
		sendMessage,
		listMessages,
		listChats,
		listSessions,
		persistMessage,
		provider,
		startSubscription,
	} = options;
	const openProviderSession = (
		session: Session,
		options: OpenProviderSessionOptions = {},
	): Effect.Effect<boolean, SessionStartError> =>
		Effect.suspend(() => {
			const providerSessionId = crypto.randomUUID();
			let accepted = false;
			return Effect.gen(function* () {
				const ownership =
					options.initialTurnId === undefined ||
					options.initialAttemptId === undefined
						? undefined
						: {
								turnId: options.initialTurnId,
								attemptId: options.initialAttemptId,
							};
				// Resolve configuration again at the execution edge. Reactor handlers may
				// have captured this row before a provider/model switch committed.
				const ownsAttempt =
					options.initialAttemptId === undefined
						? Effect.succeed(true)
						: options.initialTurnId === undefined
							? Effect.succeed(false)
							: optionsState.activeAttempt(session.id).pipe(
									Effect.map(
										(current) =>
											current !== null &&
											current.turnId === options.initialTurnId &&
											current.attemptId === options.initialAttemptId,
									),
									Effect.orDie,
								);
				if (!(yield* ownsAttempt)) return false;
				const configured = yield* lookupSession(session.id).pipe(
					Effect.map(
						(current) =>
							current.providerId === session.providerId &&
							current.model === session.model,
					),
					Effect.catch(() => Effect.succeed(false)),
				);
				if (!configured) return false;
				const reservation = yield* optionsState
					.dispatch({
						commandId: `provider-reserve:${providerSessionId}`,
						streamId: session.id,
						expectedAttempt: ownership,
						command: {
							_tag: "ReserveProviderSession",
							ownerAttempt: ownership,
							providerId: session.providerId,
							providerSessionId,
							expectedModel: session.model,
							expectedWorktreeId: session.worktreeId,
							reservedAt: Date.now(),
						},
					})
					.pipe(
						Effect.as(true),
						Effect.catch((error) =>
							error._tag === "AttemptOwnershipConflict" ||
							error._tag === "ValidationFailed" ||
							error._tag === "SessionDeletedConflict"
								? Effect.succeed(false)
								: Effect.die(error),
						),
					);
				if (!reservation) return false;
				const ownsReservation = optionsState
					.providerReservation(session.id)
					.pipe(
						Effect.map((current) => current === providerSessionId),
						Effect.orDie,
					);
				const admitted = ownsAttempt.pipe(
					Effect.flatMap((owned) =>
						owned ? ownsReservation : Effect.succeed(false),
					),
				);

				state.setRuntimeMode(session.id, session.runtimeMode);
				const subagents = agentsFor(session.id);
				const cwdOverride = yield* cwdForWorktree(session.worktreeId);
				const gitService = yield* Effect.serviceOption(RuntimeGitExecution);
				const execution = Option.isSome(gitService)
					? yield* Effect.tryPromise({
							try: () => gitService.value.resolve(session.id),
							catch: (cause) =>
								new SessionStartError({
									providerId: session.providerId,
									reason:
										cause instanceof Error
											? cause.message
											: "GitHub authentication required",
								}),
						})
					: undefined;
				const author = {
					actor: execution?.context.actor,
					githubSlackMessageId: execution?.context.slackMessageId,
				};
				const orchestrationTools = yield* makeConversationOrchestration(
					{
						runtime,
						getSettings: configStore.getSettings,
						getModelCatalog: modelCatalog.current,
						createWorktree: (projectId, source) =>
							worktrees.create(projectId, source),
						createChat: (input) => createChat({ ...input, ...author }),
						createSession: (input) => createSession({ ...input, ...author }),
						getChat: lookupChat,
						getSession: lookupSession,
						sendToSession: (sessionId, text, origin) =>
							sendMessage(
								`orchestration-send:${sessionId}:${crypto.randomUUID()}`,
								sessionId,
								text,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								origin,
								undefined,
								author.actor,
								author.githubSlackMessageId,
							),
						listMessages,
						listChats,
						listSessions,
						persistMessage,
					},
					{
						sessionId: session.id,
						chatId: session.chatId,
						projectId: session.projectId,
						worktreeId: session.worktreeId,
						providerId: session.providerId,
						model: session.model,
					},
				);
				const started = yield* provider
					.start(
						{
							folderId: session.projectId,
							providerId: session.providerId,
							mode: "sdk",
							sessionId: session.id,
							initialPrompt: options.initialPrompt,
							initialTurnId: options.initialTurnId,
							initialAttemptId: options.initialAttemptId,
							model: session.model,
							agents: subagents?.agents,
							enableSubagents:
								options.enableSubagents ?? subagents?.enableSubagents,
							cwdOverride,
							permissionMode: session.permissionMode,
							modelOptions: options.modelOptions,
							toolSearch: session.toolSearch,
							forkFromResume: options.forkFromResume,
						},
						session.providerThread?.nativeThreadRef.nativeId ?? null,
						() => state.runtimeMode(session.id),
						orchestrationTools,
						session.providerThread?.nativeHeadRef?.nativeId ?? null,
						admitted.pipe(
							Effect.flatMap((owned) =>
								!owned
									? Effect.succeed(false)
									: lookupSession(session.id).pipe(
											Effect.map(
												(current) =>
													current.archivedAt === null &&
													current.providerId === session.providerId &&
													current.model === session.model,
											),
											Effect.catch(() => Effect.succeed(false)),
										),
							),
						),
						providerSessionId,
					)
					.pipe(
						Effect.mapError((error) =>
							error._tag === "ProviderNotAvailableError"
								? new SessionStartError({
										providerId: session.providerId,
										reason: error.reason,
									})
								: error._tag === "AgentSessionStartError"
									? new SessionStartError({
											providerId: error.providerId,
											reason: error.reason,
										})
									: new SessionStartError({
											providerId: session.providerId,
											reason: formatProviderFailure(error),
										}),
						),
					);
				if (started.superseded === true) return false;
				const publishable = yield* lookupSession(session.id).pipe(
					Effect.map(
						(current) =>
							current.providerId === session.providerId &&
							current.model === session.model,
					),
					Effect.catch(() => Effect.succeed(false)),
				);
				if (!publishable) {
					// The durable provider switch owns teardown. Closing by session id here
					// could race with a newer startup and accidentally close its handle.
					return false;
				}
				const publish = (
					effect: Effect.Effect<
						void,
						| SessionStartError
						| AttemptOwnershipConflict
						| ProviderSessionOwnershipConflict
					>,
				) =>
					admitted.pipe(
						Effect.flatMap((current) =>
							!current
								? Effect.succeed(false)
								: started.generation === undefined
									? effect.pipe(Effect.as(true))
									: provider.guardCurrent(
											session.id,
											started.generation,
											effect,
										),
						),
						Effect.catchTag("AttemptOwnershipConflict", () =>
							Effect.succeed(false),
						),
						Effect.catchTag("ProviderSessionOwnershipConflict", () =>
							Effect.succeed(false),
						),
					);
				const attach = dispatchReservedRuntimeCommand(optionsState, {
					commandId: `provider-attach:${providerSessionId}`,
					streamId: session.id,
					expectedAttempt: ownership,
					expectedProviderSessionId: providerSessionId,
					command: {
						_tag: "AttachProvider",
						providerId: session.providerId,
						providerSessionId,
						attachedAt: Date.now(),
					},
				}).pipe(Effect.asVoid);
				const status = (value: Session["status"]) =>
					dispatchReservedRuntimeCommand(optionsState, {
						commandId: `provider-start-status:${providerSessionId}:${value}`,
						streamId: session.id,
						expectedAttempt: ownership,
						expectedProviderSessionId: providerSessionId,
						command: {
							_tag: "SetStatus",
							status: value,
							updatedAt: Date.now(),
						},
					}).pipe(Effect.asVoid);

				// Keep every externally visible handoff behind the lease. Guarding only
				// `start()` still lets a stopped generation attach or publish `running`.
				if (!(yield* publish(attach))) return false;
				// Publish startup status before consuming buffered provider events. A fast
				// completion must remain authoritative after startup returns.
				if (
					options.postBootStatus !== undefined &&
					!(yield* publish(status(options.postBootStatus)))
				)
					return false;
				if (
					!(yield* publish(
						startSubscription(
							session.id,
							ownership === undefined
								? undefined
								: { ...ownership, providerSessionId },
						),
					))
				)
					return false;
				if (
					options.sendAfterOpen !== undefined &&
					!(yield* publish(
						provider
							.send(
								session.id,
								options.sendAfterOpen.turnId,
								options.sendAfterOpen.text,
								options.sendAfterOpen.attachments,
								options.sendAfterOpen.fileRefs,
								options.sendAfterOpen.skillRefs,
								options.sendAfterOpen.attemptId,
							)
							.pipe(
								Effect.catchTag("AgentSessionNotFoundError", () =>
									Effect.fail(
										new SessionStartError({
											providerId: session.providerId,
											reason: "Provider session disappeared after start.",
										}),
									),
								),
							),
					))
				)
					return false;
				accepted = true;
				return true;
			}).pipe(
				Effect.onExit((exit) =>
					accepted && Exit.isSuccess(exit)
						? Effect.void
						: dispatchReservedRuntimeCommand(optionsState, {
								commandId: `provider-abandon:${providerSessionId}`,
								streamId: session.id,
								expectedProviderSessionId: providerSessionId,
								command: {
									_tag: "RequestProviderStop",
									requestedAt: Date.now(),
								},
							}).pipe(
								Effect.catchTag(
									"ProviderSessionOwnershipConflict",
									() => Effect.void,
								),
								Effect.catchTag("AttemptOwnershipConflict", () => Effect.void),
								Effect.ensuring(
									provider
										.close(session.id, undefined, providerSessionId)
										.pipe(Effect.catch(() => Effect.void)),
								),
								Effect.asVoid,
							),
				),
			);
		});

	/** The only external startup seam: callers identify durable work, while this
	 * module resolves the latest provider configuration and owns the handoff. */
	const ensureForTurn = (
		sessionId: SessionId,
		options: OpenProviderSessionOptions = {},
	): Effect.Effect<boolean, SessionStartError> =>
		awaitWorkspaceReady.pipe(
			Effect.andThen(lookupSession(sessionId)),
			Effect.mapError(
				() =>
					new SessionStartError({
						providerId: "codex",
						reason: "Session disappeared before provider startup.",
					}),
			),
			Effect.flatMap((session) => openProviderSession(session, options)),
		);

	return { ensureForTurn };
};
