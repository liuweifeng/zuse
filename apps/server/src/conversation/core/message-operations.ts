import {
	AgentTurnId,
	type AttachmentRef,
	type ComposerAnnotation,
	ComposerInput,
	DirectoryUnavailableError,
	type FileRef,
	type MessageContent,
	type MessageId,
	type MessageOrigin,
	type MessageSource,
	type Session,
	type SessionId,
	SessionStartError,
	type SkillRef,
	type TurnInterruptReceipt,
	type WorkspaceActor,
} from "@zuse/contracts";
import type { SessionCommand } from "@zuse/domain/core/commands";
import type { CommandReceiptIdentity } from "@zuse/domain/engine/dispatch";
import { Cause, Effect, type FileSystem, type Scope } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ConversationOperations } from "../services/conversation-services.ts";
import { isGoalCapableProvider } from "./conversation-goal-operations.ts";
import type { ConversationGoalState } from "./conversation-goal-state.ts";
import { serializeAnnotations } from "./conversation-input.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import type { OpenProviderSessionOptions } from "./provider-session-runtime.ts";
import {
	decodeProviderModelOptions,
	decodeProviderStartRequest,
	decodeProviderTurnInput,
} from "./provider-turn-request.ts";
import type { QueueServiceRuntime } from "./queue-service-runtime.ts";
import { makeQueueServiceRuntime } from "./queue-service-runtime.ts";
import { assertSessionInputUnblocked } from "./session-input-admission.ts";

export interface MessageOperationsOptions {
	readonly sql: SqlClient.SqlClient;
	readonly fs: FileSystem.FileSystem;
	readonly goalState: ConversationGoalState;
	readonly lookupSession: ConversationOperations["getSession"];
	readonly ensureForTurn: (
		sessionId: SessionId,
		options?: OpenProviderSessionOptions,
	) => Effect.Effect<boolean, SessionStartError>;
	readonly setStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => Effect.Effect<void>;
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
		idOverride?: MessageId,
		turnIdOverride?: AgentTurnId,
	) => Effect.Effect<PersistedMessage>;
	readonly submitTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		content: MessageContent,
		providerInputJson: string,
		idOverride?: MessageId,
		commandId?: string,
		receiptIdentity?: CommandReceiptIdentity,
	) => Effect.Effect<PersistedMessage>;
	readonly ndjsonAppend: (
		sessionId: SessionId,
		persisted: PersistedMessage,
	) => Effect.Effect<void>;
	readonly setGoal: ConversationOperations["setGoal"];
	readonly dispatchSessionCommand: (
		sessionId: SessionId,
		command: SessionCommand,
	) => Effect.Effect<void>;
	readonly dispatchSessionCommandWithId: (
		sessionId: SessionId,
		commandId: string,
		command: SessionCommand,
	) => Effect.Effect<import("@zuse/domain/engine/dispatch").CommandReceipt>;
	readonly dispatchSessionCommandWithIdTransactionally: <A, R>(
		sessionId: SessionId,
		commandId: string,
		command: SessionCommand,
		onCommitted: (
			receipt: import("@zuse/domain/engine/dispatch").CommandReceipt,
		) => Effect.Effect<A, never, R>,
	) => Effect.Effect<A, never, R>;
	readonly settleTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		reason: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	readonly resolveActiveTurn: (
		sessionId: SessionId,
	) => Effect.Effect<AgentTurnId | undefined>;
	readonly runSessionReactors: (sessionId: SessionId) => Effect.Effect<void>;
	readonly serviceScope: Scope.Scope;
	readonly hasPendingProviderTurn: (
		sessionId: SessionId,
	) => Effect.Effect<boolean>;
	readonly closeProvider: (sessionId: SessionId) => Effect.Effect<void>;
	readonly hasProvider: (sessionId: SessionId) => Effect.Effect<boolean>;
	readonly interruptProviderFiber: (
		sessionId: SessionId,
	) => Effect.Effect<void>;
}

export interface MessageOperations {
	readonly resumeSession: ConversationOperations["resumeSession"];
	readonly sendMessage: ConversationOperations["sendMessage"];
	readonly sendMessageWithInput: ConversationOperations["sendMessageWithInput"];
	readonly interruptSession: ConversationOperations["interruptSession"];
	readonly queueRuntime: QueueServiceRuntime;
}

export const makeMessageOperations = Effect.fn("MessageOperations.make")(
	function* (options: MessageOperationsOptions) {
		const {
			sql,
			fs,
			goalState,
			lookupSession,
			ensureForTurn,
			submitTurn,
			setGoal,
			dispatchSessionCommand,
			settleTurn,
			resolveActiveTurn,
			runSessionReactors,
			serviceScope,
			hasPendingProviderTurn,
			closeProvider,
			hasProvider,
			interruptProviderFiber,
		} = options;
		const pendingProviderTurn = (sessionId: SessionId, turnId: AgentTurnId) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					readonly provider_input_json: string;
					readonly provider_start_json: string | null;
				}>`
					SELECT
						json_extract(payload_json, '$.providerInputJson') AS provider_input_json,
						COALESCE(
							json_extract(payload_json, '$.providerStartJson'),
							(
								SELECT json_extract(created.payload_json, '$.providerStartJson')
								FROM events created
								WHERE created.stream_kind = 'session'
									AND created.stream_id = ${sessionId}
									AND created.type = 'SessionCreated'
								ORDER BY created.stream_version ASC
								LIMIT 1
							)
						) AS provider_start_json
					FROM events
					WHERE stream_kind = 'session'
						AND stream_id = ${sessionId}
						AND type = 'ProviderTurnRequested'
						AND json_extract(payload_json, '$.turnId') = ${turnId}
					ORDER BY stream_version DESC
					LIMIT 1
				`.pipe(Effect.orDie);
				const row = rows[0];
				if (row === undefined) return null;
				const input = yield* decodeProviderTurnInput(
					row.provider_input_json,
				).pipe(Effect.orDie);
				const startup =
					row.provider_start_json === null
						? null
						: yield* decodeProviderStartRequest(row.provider_start_json).pipe(
								Effect.orDie,
							);
				const startupJson = row.provider_start_json;
				const modelOptions =
					startup?.modelOptionsJson == null
						? undefined
						: yield* decodeProviderModelOptions(startup.modelOptionsJson).pipe(
								Effect.orDie,
							);
				return { input, startup, startupJson, modelOptions };
			});
		const restartSession = (
			sessionId: SessionId,
			reason: "retry" | "provider_recovery" = "retry",
		): ReturnType<ConversationOperations["resumeSession"]> =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);

				yield* closeProvider(sessionId);
				yield* interruptProviderFiber(sessionId);
				const activeTurnId = yield* resolveActiveTurn(sessionId);
				const request =
					activeTurnId === undefined
						? null
						: yield* pendingProviderTurn(sessionId, activeTurnId);

				if (activeTurnId !== undefined && request === null) {
					yield* settleTurn(sessionId, activeTurnId, "interrupted");
				}
				const turnId = request === null ? undefined : activeTurnId;
				if (turnId === undefined || request === null) {
					yield* ensureForTurn(session.id, {
						initialPrompt: request?.startup?.initialPrompt ?? undefined,
						modelOptions: request?.modelOptions,
						enableSubagents: request?.startup?.enableSubagents,
						forkFromResume: request?.startup?.forkFromResume,
						forkSourceThreadId: request?.startup?.forkSourceThreadId,
						postBootStatus: "idle",
					});
					return yield* lookupSession(sessionId);
				}

				yield* dispatchSessionCommand(sessionId, {
					_tag: "RetryTurn",
					turnId,
					reason,
					providerInputJson: JSON.stringify(request.input),
					...(request.startupJson === null
						? {}
						: { providerStartJson: request.startupJson }),
					requestedAt: Date.now(),
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.fail(
							new SessionStartError({
								providerId: session.providerId,
								reason: String(Cause.squash(cause)),
							}),
						),
					),
				);
				return yield* lookupSession(sessionId);
			});

		const submitUserMessage = (
			commandId: string,
			sessionId: SessionId,
			text: string,
			attachments?: ReadonlyArray<AttachmentRef>,
			fileRefs?: ReadonlyArray<FileRef>,
			skillRefs?: ReadonlyArray<SkillRef>,
			annotations?: ReadonlyArray<ComposerAnnotation>,
			asGoal?: boolean,
			clientMessageId?: MessageId,
			origin?: MessageOrigin,
			receiptIdentity?: CommandReceiptIdentity,
			turnIdOverride?: AgentTurnId,
			actor?: WorkspaceActor,
			githubSlackMessageId?: string,
			source?: MessageSource,
		): ReturnType<ConversationOperations["sendMessageWithInput"]> =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				yield* assertSessionInputUnblocked(sql, sessionId, commandId);
				const directoryRows = yield* sql<{
					readonly project_id: string;
					readonly project_path: string | null;
					readonly worktree_id: string | null;
					readonly worktree_path: string | null;
					readonly archived_worktree_json: string | null;
				}>`
          SELECT c.project_id, p.path AS project_path, c.worktree_id,
                 w.path AS worktree_path, c.archived_worktree_json
          FROM chats c
          LEFT JOIN projects p ON p.id = c.project_id
          LEFT JOIN worktrees w ON w.id = c.worktree_id
          WHERE c.id = ${session.chatId}
          LIMIT 1
        `.pipe(Effect.orDie);
				const directory = directoryRows[0];
				if (directory !== undefined) {
					const expectsWorktree =
						directory.worktree_id !== null ||
						directory.archived_worktree_json !== null;
					const path = expectsWorktree
						? directory.worktree_path
						: directory.project_path;
					const available =
						path !== null &&
						(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)));
					if (!available) {
						yield* closeProvider(sessionId).pipe(Effect.ignore);
						yield* interruptProviderFiber(sessionId).pipe(Effect.ignore);
						return yield* Effect.fail(
							new DirectoryUnavailableError({
								folderId: session.projectId,
								worktreeId: session.worktreeId,
								reason: expectsWorktree
									? "worktree-missing"
									: "project-missing",
							}),
						);
					}
				}
				if (
					asGoal !== true &&
					clientMessageId === undefined &&
					turnIdOverride === undefined &&
					isGoalCapableProvider(session.providerId)
				) {
					const goal = goalState.current(sessionId);
					const trimmed = text.trim();
					if (
						goal !== undefined &&
						goal !== null &&
						goal.status === "active" &&
						goal.objective.trim() === trimmed &&
						(yield* goalState.latestUserMessageMatches(sessionId, trimmed))
					) {
						return { accepted: true };
					}
				}
				const turnId =
					turnIdOverride ?? AgentTurnId.make(`turn_${crypto.randomUUID()}`);

				const cleanAttachments = (attachments ?? []).filter(
					(a) => !a.id.startsWith("pending-"),
				);
				const annotationList = annotations ?? [];
				const hasRichSegments =
					cleanAttachments.length > 0 ||
					(fileRefs ?? []).length > 0 ||
					(skillRefs ?? []).length > 0 ||
					annotationList.length > 0;
				const content: MessageContent = hasRichSegments
					? {
							_tag: "user_rich",
							...(actor !== undefined ? { actor } : {}),
							text,
							attachments: cleanAttachments,
							fileRefs: fileRefs ?? [],
							skillRefs: skillRefs ?? [],
							annotations: annotationList,
							...(origin !== undefined ? { origin } : {}),
							...(source !== undefined ? { source } : {}),
							goal: asGoal === true,
						}
					: {
							_tag: "user",
							...(actor !== undefined ? { actor } : {}),
							text,
							...(origin !== undefined ? { origin } : {}),
							...(source !== undefined ? { source } : {}),
							goal: asGoal === true,
						};

				const sendText = [
					annotationList.length > 0
						? serializeAnnotations(annotationList)
						: null,
					text,
				]
					.filter((part): part is string => part !== null && part.length > 0)
					.join("\n\n")
					.trim();
				const providerInput = new ComposerInput({
					text: sendText,
					attachments: cleanAttachments,
					fileRefs: fileRefs ?? [],
					skillRefs: skillRefs ?? [],
					annotations: annotationList,
				});
				if (asGoal === true && text.trim().length === 0)
					return { accepted: false };
				if (asGoal === true && !isGoalCapableProvider(session.providerId)) {
					const user = yield* options.persistMessage(
						sessionId,
						content,
						clientMessageId,
					);
					yield* options.ndjsonAppend(sessionId, user);
					const error = yield* options.persistMessage(sessionId, {
						_tag: "error",
						message:
							"Goal mode is currently only supported for Codex and Grok sessions.",
					});
					yield* options.ndjsonAppend(sessionId, error);
					return { accepted: false, messageId: user.message.id };
				}
				const persisted = yield* submitTurn(
					sessionId,
					turnId,
					content,
					JSON.stringify({
						...providerInput,
						actor,
						githubSlackMessageId,
						goal:
							asGoal === true
								? { objective: text.trim(), status: "active" }
								: undefined,
					}),
					clientMessageId,
					commandId,
					receiptIdentity,
				);

				for (const a of cleanAttachments) {
					yield* sql`
            INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
            VALUES (${persisted.message.id}, ${a.id})
          `.pipe(Effect.ignore);
				}

				return {
					accepted: true,
					messageId: persisted.message.id,
					turnId: persisted.turnId ?? turnId,
				};
			});

		const sendMessageWithInput: ConversationOperations["sendMessageWithInput"] =
			(input) =>
				Effect.gen(function* () {
					const result = yield* submitUserMessage(
						input.commandId,
						input.sessionId,
						input.text,
						input.attachments,
						input.fileRefs,
						input.skillRefs,
						input.annotations,
						input.asGoal,
						input.messageId,
						input.origin,
						input.receiptIdentity,
						input.turnId,
						input.actor,
						input.githubSlackMessageId,
						input.source,
					);
					if (!result.accepted) {
						const turnId = yield* resolveActiveTurn(input.sessionId);
						if (turnId !== undefined)
							yield* settleTurn(input.sessionId, turnId, "error");
					}
					return result;
				});

		const sendMessage: ConversationOperations["sendMessage"] = (
			commandId,
			sessionId,
			text,
			attachments,
			fileRefs,
			skillRefs,
			annotations,
			asGoal,
			clientMessageId,
			origin,
			receiptIdentity,
			actor,
			githubSlackMessageId,
		) =>
			sendMessageWithInput({
				commandId,
				sessionId,
				text,
				attachments,
				fileRefs,
				skillRefs,
				annotations,
				asGoal,
				messageId: clientMessageId,
				origin,
				receiptIdentity,
				actor,
				githubSlackMessageId,
			}).pipe(Effect.asVoid);

		const queueRuntime = yield* makeQueueServiceRuntime({
			resumeFailedSession: (sessionId) =>
				restartSession(sessionId).pipe(Effect.asVoid, Effect.orDie),
			serviceScope,
			sql,
			lookupSession,
			submitUserMessage: (
				commandId,
				sessionId,
				input,
				clientMessageId,
				actor,
			) =>
				submitUserMessage(
					commandId,
					sessionId,
					input.text,
					input.attachments,
					input.fileRefs,
					input.skillRefs,
					input.annotations,
					input.asGoal,
					clientMessageId,
					undefined,
					undefined,
					undefined,
					actor,
				).pipe(Effect.map((result) => result.accepted)),
			setQueuePaused: (sessionId, paused, commandId) => {
				const command = {
					_tag: "SetQueuePaused" as const,
					paused,
					updatedAt: Date.now(),
				};
				return commandId === undefined
					? dispatchSessionCommand(sessionId, command)
					: options
							.dispatchSessionCommandWithId(sessionId, commandId, command)
							.pipe(Effect.asVoid);
			},
			dispatchSessionCommand,
			dispatchSessionCommandWithId: (sessionId, commandId, command) =>
				options.dispatchSessionCommandWithId(sessionId, commandId, command),
			dispatchSessionCommandWithIdTransactionally: (
				sessionId,
				commandId,
				command,
				onCommitted,
			) =>
				options.dispatchSessionCommandWithIdTransactionally(
					sessionId,
					commandId,
					command,
					onCommitted,
				),
			runSessionReactors,
			resolveActiveTurn,
		});
		const resumeSession: ConversationOperations["resumeSession"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				const session = yield* lookupSession(sessionId);
				if (
					session.status !== "error" &&
					((yield* hasPendingProviderTurn(sessionId)) ||
						(yield* hasProvider(sessionId)))
				) {
					return session;
				}
				return yield* restartSession(sessionId);
			});
		const interruptSession: ConversationOperations["interruptSession"] = (
			commandId,
			sessionId,
			expectedTurnId,
		) =>
			Effect.gen(function* () {
				yield* lookupSession(sessionId);
				const receipt = yield* options.dispatchSessionCommandWithId(
					sessionId,
					commandId,
					{
						_tag: "RequestTurnInterrupt",
						...(expectedTurnId === undefined ? {} : { expectedTurnId }),
						requestedAt: Date.now(),
					},
				);
				const outcome = receipt.result;
				if (outcome === undefined) {
					return {
						_tag: "not-active",
						reason: "no-active-turn",
						expectedTurnId: expectedTurnId ?? null,
						actualTurnId: null,
					} satisfies TurnInterruptReceipt;
				}
				if (outcome._tag === "not-active") return outcome;
				yield* queueRuntime.pauseAfterInterrupt(sessionId);

				const goal = goalState.current(sessionId);
				const pauseGoal =
					goal?.status === "active"
						? setGoal(sessionId, { status: "paused" })
						: Effect.void;

				yield* pauseGoal.pipe(
					Effect.ensuring(runSessionReactors(sessionId)),
					Effect.orDie,
				);
				return outcome;
			});

		return {
			resumeSession,
			sendMessage,
			sendMessageWithInput,
			interruptSession,
			queueRuntime,
		};
	},
);
