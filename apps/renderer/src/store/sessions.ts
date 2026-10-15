import { getClientProtocolVersion } from "@zuse/client-runtime/connection";
import { supportsIdempotentSessionFork } from "@zuse/client-runtime/legacy-runtime-capabilities";
import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import type {
	AgentItemId,
	ChatId,
	FolderId,
	ForkDestination,
	ForkMode,
	MessageId,
	PermissionMode,
	PlanApprovalOutcome,
	ProviderId,
	RuntimeMode,
	UserQuestionAnswer,
	WorktreeId,
} from "@zuse/contracts";
import { CommandId, EnvironmentId, Session, SessionId } from "@zuse/contracts";
import {
	cloudFailurePresentation,
	cloudInteractionFailure,
} from "../lib/cloud-failure-presentation.ts";
import {
	cloudSummaryForChat,
	cloudSummaryForSelection,
	localProjectForCloudChat,
} from "../lib/cloud-workspace-catalog.ts";
import {
	activeSessionById,
	activeSessionsByProject,
	environmentShellData,
	overlayActiveEnvironmentShell,
	overlayEnvironmentShell,
} from "../lib/environment-entities.ts";
import { formatError } from "../lib/format-error.ts";
import { upsertLatestEntity } from "../lib/latest-entity.ts";
import {
	createPendingModelChanges,
	isBusyModelChange,
	type ModelSelection,
} from "../lib/pending-model-change.ts";
import { markRendererInteraction } from "../lib/performance-marks.ts";
import {
	getActiveEnvironment,
	getVerifiedRpcClient,
} from "../lib/rpc-client.ts";
import { sessionForkDestinations } from "../lib/session-fork.ts";
import {
	dispatchSessionCommand,
	getRendererClientBus,
	retainSessionTimeline,
	sessionTimelineResourceKey,
} from "../lib/session-timeline-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { selectChatSession, upsertForkedChat } from "./chat-commands.ts";
import { useWorkspaceStore } from "./workspace.ts";

type SessionsState = {
	readonly selectedSessionId: SessionId | null;

	readonly selectedSessionByProject: Record<string, SessionId | null>;
	readonly loadingByProject: Record<string, boolean>;

	readonly creatingByChat: Record<string, boolean>;

	readonly draftSession: Session | null;
	readonly draftRevision: number;
	readonly error: string | null;
	readonly pendingModelChanges: Readonly<Record<string, ModelSelection>>;
	readonly selectModel: (
		sessionId: SessionId,
		providerId: ProviderId,
		model: string,
		environmentId: EnvironmentId,
	) => Promise<
		{ readonly ok: true } | { readonly ok: false; readonly reason: string }
	>;
	readonly draftSkills: ReadonlyArray<import("@zuse/contracts").Skill>;
	readonly loadDraftSkills: (
		projectId: FolderId,
		providerId: ProviderId,
	) => Promise<void>;

	readonly beginDraft: (params: {
		projectId: FolderId;
		providerId: ProviderId;
		model: string;
		runtimeMode: RuntimeMode;
	}) => Session;

	readonly clearDraft: (expectedRevision?: number) => void;
	readonly hydrate: (projectId: FolderId) => Promise<void>;
	readonly create: (
		chatId: ChatId,
		providerId: ProviderId,
		model: string,
		opts?: {
			runtimeMode?: RuntimeMode;
			permissionMode?: PermissionMode;
			toolSearch?: boolean;
		},
	) => Promise<SessionId | null>;

	readonly fork: (input: {
		sourceSessionId: SessionId;
		fromMessageId: MessageId;
		nativeChildStepId?: string;
		destination: ForkDestination;
		providerId?: ProviderId;
		model?: string;
		worktreeId?: WorktreeId | null;
		title?: string;
	}) => Promise<{
		chatId: ChatId;
		sessionId: SessionId;
		forkMode: ForkMode | "machine";
	} | null>;

	readonly setSessionStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => void;
	readonly rename: (
		sessionId: SessionId,
		title: string,
		environmentId?: EnvironmentId,
	) => Promise<void>;
	readonly setModel: (
		sessionId: SessionId,
		model: string,
		environmentId?: EnvironmentId,
	) => Promise<void>;
	readonly setRuntimeMode: (
		sessionId: SessionId,
		runtimeMode: RuntimeMode,
		environmentId?: EnvironmentId,
	) => Promise<void>;

	readonly setPermissionMode: (
		sessionId: SessionId,
		mode: PermissionMode,
		environmentId?: EnvironmentId,
	) => Promise<void>;

	readonly answerQuestion: (
		environmentId: EnvironmentId,
		sessionId: SessionId,
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Promise<void>;

	readonly cancelQuestion: (
		environmentId: EnvironmentId,
		sessionId: SessionId,
		itemId: AgentItemId,
	) => Promise<void>;
	readonly respondToPlan: (
		sessionId: SessionId,
		toolCallId: AgentItemId,
		outcome: PlanApprovalOutcome,
		feedback?: string,
		options?: {
			readonly silent?: boolean;
			readonly environmentId?: EnvironmentId;
		},
	) => Promise<"accepted" | "session-not-found" | "failed">;

	readonly setProvider: (
		sessionId: SessionId,
		providerId: ProviderId,
		model: string,
		environmentId?: EnvironmentId,
	) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;
	readonly refreshOne: (
		sessionId: SessionId,
		environmentId?: EnvironmentId,
	) => Promise<void>;
	readonly archive: (
		sessionId: SessionId,
		environmentId?: EnvironmentId,
	) => Promise<void>;
	readonly remove: (
		sessionId: SessionId,
		environmentId?: EnvironmentId,
	) => Promise<void>;
	readonly resume: (
		sessionId: SessionId,
		environmentId?: EnvironmentId,
	) => Promise<boolean>;
	readonly select: (sessionId: SessionId | null) => void;
};

/**
 * Sentinel ids for the landing's draft session. Fixed (not random) so the
 * composer's `key` stays stable across re-renders and the setter routing can
 * recognise the draft by id without threading a flag through every toggle.
 */
export const DRAFT_SESSION_ID = "draft-session" as SessionId;
export const DRAFT_CHAT_ID = "draft-chat" as ChatId;

let commandCounter = 0;
const nextCommandId = (kind: string): CommandId =>
	CommandId.make(
		`${kind}:${Date.now().toString(36)}:${(commandCounter++).toString(36)}`,
	);

const environmentForSessionCommand = (
	sessionId: SessionId,
	explicit?: EnvironmentId,
): EnvironmentId => {
	if (explicit !== undefined) return explicit;
	const session = activeSessionById(sessionId);
	const cloud = cloudSummaryForSelection({
		chatId: session?.chatId ?? null,
		sessionId,
	});
	return EnvironmentId.make(cloud?.workspaceId ?? getActiveEnvironment());
};

const dispatchTimelineCommand = <Payload, Result>(
	sessionId: SessionId,
	kind: string,
	commandId: CommandId,
	payload: Payload,
	retry: "safe" | "never" = "safe",
	environmentId = environmentForSessionCommand(sessionId),
) =>
	dispatchSessionCommand<Payload, Result>({
		ref: {
			environmentId,
			sessionId,
		},
		kind,
		commandId,
		payload,
		retry,
	});

const findSessionProject = (
	sessionsByProject: Readonly<Record<string, ReadonlyArray<Session>>>,
	sessionId: SessionId,
): FolderId | null => {
	for (const [pid, sessions] of Object.entries(sessionsByProject)) {
		if (sessions.some((s) => s.id === sessionId)) return pid as FolderId;
	}
	return null;
};

const patchActiveSession = (
	sessionId: SessionId,
	update: (session: Session) => Session,
): void => {
	overlayActiveEnvironmentShell((shell) => {
		const projectId = findSessionProject(shell.sessionsByProject, sessionId);
		if (projectId === null) return undefined;
		return {
			...shell,
			sessionsByProject: {
				...shell.sessionsByProject,
				[projectId]: (shell.sessionsByProject[projectId] ?? []).map(
					(session) => (session.id === sessionId ? update(session) : session),
				),
			},
		};
	});
};

const removeEnvironmentSession = (
	environmentId: EnvironmentId,
	sessionId: SessionId,
): FolderId | null => {
	let owningProject: FolderId | null = null;
	overlayEnvironmentShell(environmentId, (shell) => {
		owningProject = findSessionProject(shell.sessionsByProject, sessionId);
		if (owningProject === null) return undefined;
		return {
			...shell,
			sessionsByProject: {
				...shell.sessionsByProject,
				[owningProject]: (shell.sessionsByProject[owningProject] ?? []).filter(
					(session) => session.id !== sessionId,
				),
			},
		};
	});
	return owningProject;
};

const selectionAfterSessionRemoval = (
	state: SessionsState,
	sessionId: SessionId,
	projectId: FolderId | null,
): Partial<SessionsState> => {
	const selectedSessionByProject =
		projectId !== null &&
		state.selectedSessionByProject[projectId] === sessionId
			? { ...state.selectedSessionByProject, [projectId]: null }
			: state.selectedSessionByProject;
	const selectedSessionId =
		state.selectedSessionId === sessionId ? null : state.selectedSessionId;
	if (
		selectedSessionId === state.selectedSessionId &&
		selectedSessionByProject === state.selectedSessionByProject
	)
		return {};
	return { selectedSessionId, selectedSessionByProject };
};

export const useSessionsStore = create<SessionsState>((set, get) => ({
	selectedSessionId: null,
	selectedSessionByProject: {},
	loadingByProject: {},
	creatingByChat: {},
	draftSession: null,
	draftRevision: 0,
	draftSkills: [],
	error: null,
	beginDraft: ({ projectId, providerId, model, runtimeMode }) => {
		const now = new Date();
		const draft = Session.make({
			id: DRAFT_SESSION_ID,
			projectId,
			title: "New chat",
			providerId,
			model,
			status: "idle",
			archivedAt: null,
			providerThread: null,
			runtimeMode,
			worktreeId: null,
			chatId: DRAFT_CHAT_ID,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: "default",
			toolSearch: false,
			createdAt: now,
			updatedAt: now,
		});
		set((state) => ({
			draftSession: draft,
			draftRevision: state.draftRevision + 1,
		}));
		return draft;
	},
	clearDraft: (expectedRevision) => {
		if (
			expectedRevision !== undefined &&
			get().draftRevision !== expectedRevision
		)
			return;
		set({ draftSession: null, draftSkills: [] });
	},
	loadDraftSkills: async (projectId, providerId) => {
		try {
			const { result } = await dispatchTimelineCommand<
				{ readonly projectId: FolderId; readonly providerId: ProviderId },
				ReadonlyArray<import("@zuse/contracts").Skill>
			>(
				DRAFT_SESSION_ID,
				"skill.listForProject",
				nextCommandId("draft-skills"),
				{ projectId, providerId },
				"never",
			);
			set({ draftSkills: result });
		} catch {
			set({ draftSkills: [] });
		}
	},
	hydrate: async (projectId) => {
		set((s) => ({
			loadingByProject: { ...s.loadingByProject, [projectId]: false },
			error: null,
		}));
	},
	create: async (chatId, providerId, model, opts) => {
		const sessionId = SessionId.make(`s_${crypto.randomUUID()}`);
		const source = Object.values(activeSessionsByProject())
			.flat()
			.find((session) => session.chatId === chatId);
		const projectId =
			source?.projectId ?? useWorkspaceStore.getState().selectedFolderId;
		if (projectId === null) return null;
		const now = new Date();
		const optimistic = Session.make({
			id: sessionId,
			projectId,
			title: "New chat",
			titleProvenance: "pending",
			providerId,
			model,

			status: "idle",
			archivedAt: null,
			providerThread: null,
			runtimeMode: opts?.runtimeMode ?? "approval-required",
			worktreeId: source?.worktreeId ?? null,
			chatId,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: opts?.permissionMode ?? "default",
			toolSearch: opts?.toolSearch ?? false,
			createdAt: now,
			updatedAt: now,
		});
		markRendererInteraction(sessionId, "click");
		overlayActiveEnvironmentShell((shell) => ({
			...shell,
			sessionsByProject: {
				...shell.sessionsByProject,
				[projectId]: [
					optimistic,
					...(shell.sessionsByProject[projectId] ?? []),
				],
			},
		}));
		set((s) => ({
			error: null,
			creatingByChat: { ...s.creatingByChat, [chatId]: true },
			selectedSessionId: sessionId,
			selectedSessionByProject: {
				...s.selectedSessionByProject,
				[projectId]: sessionId,
			},
		}));
		markRendererInteraction(sessionId, "first-atom-commit");
		const cloudSummary = cloudSummaryForChat(chatId);
		const environmentId = EnvironmentId.make(
			cloudSummary?.workspaceId ?? getActiveEnvironment(),
		);
		const commandId = nextCommandId("session-create");
		try {
			if (cloudSummary !== null) {
				const { ensureCloudWorkspaceAttached } = await import(
					"../lib/cloud-workspaces.ts"
				);
				await ensureCloudWorkspaceAttached(cloudSummary);
			}
			const { result: session } = await dispatchTimelineCommand<
				{
					readonly sessionId: SessionId;
					readonly chatId: ChatId;
					readonly providerId: ProviderId;
					readonly model: string;
					readonly runtimeMode?: RuntimeMode;
					readonly permissionMode?: PermissionMode;
					readonly toolSearch?: boolean;
				},
				Session
			>(
				sessionId,
				"session.create",
				commandId,
				{
					sessionId,
					chatId,
					providerId,
					model,
					runtimeMode: opts?.runtimeMode,
					permissionMode: opts?.permissionMode,
					toolSearch: opts?.toolSearch,
				},
				"safe",
				environmentId,
			);
			markRendererInteraction(sessionId, "entity-acknowledged");
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: upsertLatestEntity(
						shell.sessionsByProject[projectId] ?? [],
						session,
					),
				},
			}));
			set((s) => {
				return {
					selectedSessionId: session.id,
					selectedSessionByProject: {
						...s.selectedSessionByProject,
						[projectId]: session.id,
					},
					creatingByChat: { ...s.creatingByChat, [chatId]: false },
				};
			});
			return session.id;
		} catch (err) {
			const retryable = getRendererClientBus()
				.snapshot(
					sessionTimelineResourceKey({
						environmentId,
						sessionId,
					}),
				)
				.failedCommands.some(
					(command) => command.commandId === commandId && command.retryable,
				);
			if (retryable) {
				set((s) => ({
					error: null,
					creatingByChat: { ...s.creatingByChat, [chatId]: false },
				}));
				return sessionId;
			}
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: (shell.sessionsByProject[projectId] ?? []).map((row) =>
						row.id === sessionId
							? Session.make({ ...row, status: "error" })
							: row,
					),
				},
			}));
			set((s) => ({
				error: formatError(err),
				creatingByChat: { ...s.creatingByChat, [chatId]: false },
			}));
			return null;
		}
	},
	fork: async (input) => {
		const originEnvironment = getActiveEnvironment();
		set({ error: null });
		try {
			const source = activeSessionById(input.sourceSessionId);
			const cloud = cloudSummaryForSelection({
				chatId: source?.chatId ?? null,
				sessionId: input.sourceSessionId,
			});
			if (!sessionForkDestinations(cloud).includes(input.destination)) {
				throw new Error(
					"This fork destination is unavailable for this cloud workspace.",
				);
			}
			const environmentId = environmentForSessionCommand(input.sourceSessionId);
			if (cloud !== null) {
				const { ensureCloudWorkspaceAttached } = await import(
					"../lib/cloud-workspaces.ts"
				);
				await ensureCloudWorkspaceAttached(cloud);
				if (input.destination === "chat") {
					const projectId =
						source?.projectId ?? localProjectForCloudChat(cloud.chatId);
					if (projectId === null)
						throw new Error("The source project is no longer available.");
					const { forkCloudMachine } = await import(
						"../lib/cloud-machine-fork.ts"
					);
					return await forkCloudMachine({
						cloud,
						projectId,
						source,
						sourceSessionId: input.sourceSessionId,
						fromMessageId: input.fromMessageId,
					});
				}
			}

			const forkClient = await getVerifiedRpcClient(environmentId);
			const retry = supportsIdempotentSessionFork(
				getClientProtocolVersion(forkClient),
			)
				? "safe"
				: "never";
			const commandId = nextCommandId("session-fork");
			const { result } = await dispatchTimelineCommand<
				{
					readonly commandId: string;
					readonly sourceSessionId: SessionId;
					readonly fromMessageId: MessageId;
					readonly nativeChildStepId?: string;
					readonly destination: ForkDestination;
					readonly providerId?: ProviderId;
					readonly model?: string;
					readonly worktreeId?: WorktreeId | null;
					readonly title?: string;
				},
				{
					readonly chat: import("@zuse/contracts").Chat;
					readonly session: Session;
					readonly forkMode: ForkMode;
				}
			>(
				input.sourceSessionId,
				"session.fork",
				commandId,
				{
					commandId,
					sourceSessionId: input.sourceSessionId,
					fromMessageId: input.fromMessageId,
					destination: input.destination,
					nativeChildStepId: input.nativeChildStepId,
					providerId: input.providerId,
					model: input.model,
					worktreeId: input.worktreeId,
					title: input.title,
				},
				retry,
				environmentId,
			);
			const { forkMode } = result;

			if (getActiveEnvironment() !== originEnvironment)
				return {
					chatId: result.chat.id,
					sessionId: result.session.id,
					forkMode,
				};
			const projectId =
				cloud === null
					? result.session.projectId
					: (source?.projectId ??
						localProjectForCloudChat(result.chat.id) ??
						result.session.projectId);

			const session = { ...result.session, projectId };
			const chat = { ...result.chat, projectId };

			overlayActiveEnvironmentShell((shell) => {
				const existing = shell.sessionsByProject[projectId] ?? [];
				return {
					...shell,
					sessionsByProject: {
						...shell.sessionsByProject,
						[projectId]: [
							session,
							...existing.filter((row) => row.id !== session.id),
						],
					},
				};
			});
			set((s) => {
				return {
					selectedSessionId: session.id,
					selectedSessionByProject: {
						...s.selectedSessionByProject,
						[projectId]: session.id,
					},
				};
			});

			upsertForkedChat(chat, session);
			return { chatId: chat.id, sessionId: session.id, forkMode };
		} catch (err) {
			if (getActiveEnvironment() === originEnvironment)
				set({ error: formatError(err) });
			return null;
		}
	},
	setSessionStatus: (sessionId, status) => {
		overlayActiveEnvironmentShell((shell) => {
			const projectId = findSessionProject(shell.sessionsByProject, sessionId);
			if (projectId === null) return undefined;
			return {
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: (shell.sessionsByProject[projectId] ?? []).map((row) =>
						row.id === sessionId ? ({ ...row, status } as Session) : row,
					),
				},
			};
		});
	},
	rename: async (sessionId, title, explicitEnvironmentId) => {
		set({ error: null });
		const environmentId = environmentForSessionCommand(
			sessionId,
			explicitEnvironmentId,
		);
		try {
			const commandId = nextCommandId("session-rename");
			const { result: renamed } = await dispatchTimelineCommand<
				{
					readonly commandId: CommandId;
					readonly sessionId: SessionId;
					readonly title: string;
				},
				Session
			>(
				sessionId,
				"session.rename",
				commandId,
				{
					commandId,
					sessionId,
					title,
				},
				"safe",
				environmentId,
			);
			overlayEnvironmentShell(environmentId, (shell) => {
				const projectId = findSessionProject(
					shell.sessionsByProject,
					sessionId,
				);
				if (projectId === null) return undefined;
				return {
					...shell,
					sessionsByProject: {
						...shell.sessionsByProject,
						[projectId]: (shell.sessionsByProject[projectId] ?? []).map(
							(session) => (session.id === sessionId ? renamed : session),
						),
					},
				};
			});
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
	pendingModelChanges: {},
	selectModel: async (sessionId, providerId, model, environmentId) => {
		const draft = get().draftSession;
		if (draft?.id === sessionId) {
			set({
				draftSession: Session.make({ ...draft, providerId, model }),
				error: null,
			});
			return { ok: true };
		}
		set({ error: null });
		return pendingModelChanges.request(
			{ sessionId, environmentId },
			{ providerId, model },
		);
	},
	setModel: async (sessionId, model, environmentId) => {
		const draft = get().draftSession;
		if (draft !== null && draft.id === sessionId) {
			set({ draftSession: Session.make({ ...draft, model }) });
			return;
		}
		const owner = environmentForSessionCommand(sessionId, environmentId);
		const session = configurationSession({ environmentId: owner, sessionId });
		if (session === null) {
			set({ error: "This session is no longer available." });
			return;
		}
		await get().selectModel(sessionId, session.providerId, model, owner);
	},
	setRuntimeMode: async (sessionId, runtimeMode, environmentId) => {
		const draft = get().draftSession;
		if (draft !== null && draft.id === sessionId) {
			set({ draftSession: Session.make({ ...draft, runtimeMode }) });
			return;
		}

		set({ error: null });
		try {
			const commandId = nextCommandId("session-runtime-mode");
			await dispatchTimelineCommand(
				sessionId,
				"session.setRuntimeMode",
				commandId,
				{
					commandId,
					sessionId,
					runtimeMode,
				},
				"safe",
				environmentId,
			);
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	setPermissionMode: async (sessionId, mode, environmentId) => {
		const draft = get().draftSession;
		if (draft !== null && draft.id === sessionId) {
			set({ draftSession: Session.make({ ...draft, permissionMode: mode }) });
			return;
		}
		set({ error: null });
		patchActiveSession(sessionId, (session) =>
			Session.make({ ...session, permissionMode: mode }),
		);
		try {
			const commandId = nextCommandId("session-permission-mode");
			await dispatchTimelineCommand(
				sessionId,
				"session.setPermissionMode",
				commandId,
				{ commandId, sessionId, mode },
				"safe",
				environmentId,
			);
		} catch (err) {
			set({ error: formatError(err) });
			const projectId = findSessionProject(
				activeSessionsByProject(),
				sessionId,
			);
			if (projectId !== null) await get().hydrate(projectId);
		}
	},
	answerQuestion: async (environmentId, sessionId, itemId, answers) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-answer-question");
			await dispatchTimelineCommand(
				sessionId,
				"session.answerQuestion",
				commandId,
				{ commandId, sessionId, itemId, answers },
				"safe",
				environmentId,
			);
		} catch (err) {
			const failure = cloudInteractionFailure(err);
			set({ error: failure.presentation?.message ?? formatError(err) });
			throw err;
		}
	},
	cancelQuestion: async (environmentId, sessionId, itemId) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-cancel-question");
			await dispatchTimelineCommand(
				sessionId,
				"session.cancelQuestion",
				commandId,
				{ commandId, sessionId, itemId },
				"safe",
				environmentId,
			);
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
	respondToPlan: async (sessionId, toolCallId, outcome, feedback, options) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-plan-response");
			await dispatchTimelineCommand(
				sessionId,
				"session.plan.respond",
				commandId,
				{
					sessionId,
					toolCallId,
					outcome,
					commandId,
					...(feedback === undefined ? {} : { feedback }),
				},
				"safe",
				options?.environmentId,
			);
			return "accepted";
		} catch (error) {
			const failure = cloudInteractionFailure(error);
			const message = failure.presentation?.message ?? formatError(error);
			if (failure.expired) {
				if (options?.silent !== true) set({ error: message });
				return "session-not-found";
			}
			set({ error: message });
			return "failed";
		}
	},
	setProvider: async (sessionId, providerId, model, environmentId) => {
		const draft = get().draftSession;
		if (draft !== null && draft.id === sessionId) {
			set({ draftSession: Session.make({ ...draft, providerId, model }) });
			return { ok: true } as const;
		}
		return get().selectModel(
			sessionId,
			providerId,
			model,
			environmentForSessionCommand(sessionId, environmentId),
		);
	},
	archive: async (sessionId, explicitEnvironmentId) => {
		set({ error: null });
		const environmentId = environmentForSessionCommand(
			sessionId,
			explicitEnvironmentId,
		);
		try {
			const commandId = nextCommandId("session-archive");
			await dispatchTimelineCommand(
				sessionId,
				"session.archive",
				commandId,
				{ sessionId },
				"never",
				environmentId,
			);
			const projectId = removeEnvironmentSession(environmentId, sessionId);
			set((state) => selectionAfterSessionRemoval(state, sessionId, projectId));
		} catch (err) {
			const presentation = cloudFailurePresentation({ cause: err });
			if (presentation?.kind === "session-unavailable") {
				const projectId = removeEnvironmentSession(environmentId, sessionId);
				set((state) =>
					selectionAfterSessionRemoval(state, sessionId, projectId),
				);
				return;
			}
			set({ error: presentation?.message ?? formatError(err) });
		}
	},
	remove: async (sessionId, explicitEnvironmentId) => {
		set({ error: null });
		const environmentId = environmentForSessionCommand(
			sessionId,
			explicitEnvironmentId,
		);
		try {
			const commandId = nextCommandId("session-delete");
			await dispatchTimelineCommand(
				sessionId,
				"session.delete",
				commandId,
				{ sessionId },
				"never",
				environmentId,
			);
			const projectId = removeEnvironmentSession(environmentId, sessionId);
			set((state) => selectionAfterSessionRemoval(state, sessionId, projectId));
		} catch (err) {
			const presentation = cloudFailurePresentation({ cause: err });
			if (presentation?.kind === "session-unavailable") {
				const projectId = removeEnvironmentSession(environmentId, sessionId);
				set((state) =>
					selectionAfterSessionRemoval(state, sessionId, projectId),
				);
				return;
			}
			set({ error: presentation?.message ?? formatError(err) });
		}
	},
	resume: async (
		sessionId,
		environmentId = EnvironmentId.make(getActiveEnvironment()),
	) => {
		set({ error: null });
		try {
			const commandId = nextCommandId("session-resume");
			const { result: session } = await dispatchTimelineCommand<
				{ readonly sessionId: SessionId },
				Session
			>(
				sessionId,
				"session.resume",
				commandId,
				{ sessionId },
				"never",
				environmentId,
			);
			const projectId = session.projectId;
			overlayEnvironmentShell(environmentId, (shell) => ({
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: upsertLatestEntity(
						shell.sessionsByProject[projectId] ?? [],
						session,
					),
				},
			}));
			set((s) => ({
				selectedSessionId: session.id,
				selectedSessionByProject: {
					...s.selectedSessionByProject,
					[projectId]: session.id,
				},
			}));
			return true;
		} catch (err) {
			set({ error: formatError(err) });
			return false;
		}
	},
	refreshOne: async (sessionId, environmentId) => {
		try {
			const commandId = nextCommandId("session-get");
			const { result: session } = await dispatchTimelineCommand<
				{ readonly sessionId: SessionId },
				Session
			>(
				sessionId,
				"session.get",
				commandId,
				{ sessionId },
				"never",
				environmentId,
			);
			patchActiveSession(sessionId, () => session);
		} catch {}
	},
	select: (sessionId) => {
		if (sessionId === null) {
			set((s) => {
				const activeProjectId = useWorkspaceStore.getState().selectedFolderId;
				return {
					selectedSessionId: null,
					selectedSessionByProject:
						activeProjectId !== null
							? { ...s.selectedSessionByProject, [activeProjectId]: null }
							: s.selectedSessionByProject,
				};
			});
			return;
		}
		const sessionsByProject = activeSessionsByProject();
		const projectId = findSessionProject(sessionsByProject, sessionId);

		set((s) => ({
			selectedSessionId: sessionId,
			selectedSessionByProject:
				projectId !== null
					? { ...s.selectedSessionByProject, [projectId]: sessionId }
					: s.selectedSessionByProject,
		}));

		const sessionRow =
			projectId !== null
				? sessionsByProject[projectId]?.find((row) => row.id === sessionId)
				: undefined;
		if (sessionRow !== undefined) {
			selectChatSession(sessionRow.chatId, sessionId);
		}

		if (
			projectId !== null &&
			useWorkspaceStore.getState().selectedFolderId !== projectId
		) {
			void useWorkspaceStore.getState().select(projectId);
		}
	},
}));

useWorkspaceStore.subscribe((ws, prev) => {
	if (ws.selectedFolderId === prev.selectedFolderId) return;
	const slot =
		ws.selectedFolderId !== null
			? (useSessionsStore.getState().selectedSessionByProject[
					ws.selectedFolderId
				] ?? null)
			: null;
	if (useSessionsStore.getState().selectedSessionId !== slot) {
		useSessionsStore.setState({ selectedSessionId: slot });
	}
});

const configurationSession = (ref: {
	environmentId: EnvironmentId;
	sessionId: SessionId;
}) =>
	Object.values(
		environmentShellData(ref.environmentId)?.sessionsByProject ?? {},
	)
		.flat()
		.find((session) => session.id === ref.sessionId) ?? null;
const pendingModelChanges = createPendingModelChanges({
	current: configurationSession,
	snapshot: (ref) =>
		getRendererClientBus().snapshot(sessionTimelineResourceKey(ref)),
	retain: (ref, listener) => {
		const { key, lease } = retainSessionTimeline(ref, "connect");
		const unsubscribe = getRendererClientBus().subscribe(key, listener);
		return () => {
			unsubscribe();
			lease.release();
		};
	},
	apply: async (ref, selection) => {
		const sameProvider =
			configurationSession(ref)?.providerId === selection.providerId;
		const commandId = nextCommandId(
			sameProvider ? "session-model" : "session-provider",
		);
		try {
			await dispatchTimelineCommand(
				ref.sessionId,
				sameProvider ? "session.setModel" : "session.setProvider",
				commandId,
				sameProvider
					? { sessionId: ref.sessionId, model: selection.model }
					: { sessionId: ref.sessionId, ...selection },
				"never",
				ref.environmentId,
			);
		} catch (error) {
			if (isBusyModelChange(error))
				getRendererClientBus().dismissFailedCommand(
					sessionTimelineResourceKey(ref),
					commandId,
				);
			throw error;
		}
		overlayEnvironmentShell(ref.environmentId, (shell) => {
			const projectId = findSessionProject(
				shell.sessionsByProject,
				ref.sessionId,
			);
			if (projectId === null) return undefined;
			return {
				...shell,
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: (shell.sessionsByProject[projectId] ?? []).map(
						(session) =>
							session.id === ref.sessionId
								? Session.make({ ...session, ...selection })
								: session,
					),
				},
			};
		});
	},
	changed: (ref, selection) =>
		useSessionsStore.setState((state) => {
			const pendingModelChanges = { ...state.pendingModelChanges };
			const key = resourceRefKey(ref);
			if (selection === null) delete pendingModelChanges[key];
			else pendingModelChanges[key] = selection;
			return { pendingModelChanges };
		}),
	failed: (error) => {
		const reason = formatError(error);
		useSessionsStore.setState({ error: reason });
		return reason;
	},
});

if (import.meta.hot)
	import.meta.hot.dispose(() => pendingModelChanges.dispose());
