import type {
	PermissionMode,
	ProviderTurnReference,
	RuntimeMode,
	SessionStatus,
} from "@zuse/contracts";
import { MessageContent } from "@zuse/contracts";
import { Result, Schema } from "effect";
import { derive, scopeProviderThreadId } from "../agent-engine/ids.js";
import { type TitleProvenance, titleProvenanceOrManual } from "../naming.js";
import type { TurnPhase } from "./commands.js";
import type { SessionEvent } from "./events.js";

const decodeInputContent = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);

export type OpenSegment = {
	readonly turnId: string;
	readonly kind: "assistant" | "reasoning" | "tool";
};

export type QueuedTurn = {
	readonly queueId: string;
	readonly inputJson: string;
	readonly position: number;
	readonly createdAt: number;
	readonly ready: boolean;
};

export type ScheduledSuccessor = {
	readonly predecessorTurnId: string;
	readonly turnId: string;
	readonly queueId: string;
	readonly inputJson: string;
};

export type MessageCheckpointState = {
	readonly revision: number;
	readonly final: boolean;
};

/**
 * A provider-native conversation handle owned by this session. The native id
 * is a reference the driver needs to resume; the app id is the identity.
 */
export type ProviderThreadState = {
	readonly id: string;
	readonly provider: string;
	readonly nativeThreadId: string;
	readonly nativeHeadId: string | null;
	readonly status: "not_loaded" | "idle" | "active" | "closed" | "error";
	readonly firstTurnOrdinal: number | null;
	readonly lastTurnOrdinal: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type AttemptReason = "initial" | "retry" | "provider_recovery";

export type AttemptState = {
	readonly id: string;
	readonly ordinal: number;
	readonly reason: AttemptReason;
	readonly status:
		| "running"
		| "completed"
		| "interrupted"
		| "failed"
		| "superseded";
	readonly startedAt: number;
	readonly completedAt: number | null;
};

export type TurnStatus =
	| "rolled_back"
	| "finalizing"
	| "starting"
	| "running"
	| "completed"
	| "interrupted"
	| "failed";

/**
 * One counted user turn. The turn keeps its id and ordinal across attempts;
 * only `activeAttemptId` moves when a retry or recovery starts.
 */
export type TurnState = {
	readonly id: string;
	readonly ordinal: number;
	readonly status: TurnStatus;
	readonly phase: TurnPhase | null;
	readonly providerThreadId: string | null;
	readonly activeAttemptId: string;
	readonly attempts: ReadonlyMap<string, AttemptState>;
	readonly requestedAt: number;
	readonly completedAt: number | null;
};

export type SessionState = {
	readonly exists: boolean;
	readonly sessionId: string | null;
	readonly chatId: string | null;
	readonly projectId: string | null;
	readonly title: string | null;
	readonly titleProvenance: TitleProvenance;
	readonly model: string | null;
	readonly status: SessionStatus | null;
	readonly queuePaused: boolean;
	readonly runtimeMode: RuntimeMode | null;
	readonly worktreeId: string | null;
	readonly permissionMode: PermissionMode | null;
	readonly archived: boolean;
	readonly deleted: boolean;
	/** Provider-native conversations this session has used, by app id. */
	readonly providerThreads: ReadonlyMap<string, ProviderThreadState>;
	readonly activeProviderThreadId: string | null;
	/** Every counted turn, by turn id. */
	readonly turns: ReadonlyMap<string, TurnState>;
	readonly attemptRecoveries: ReadonlyMap<
		string,
		{
			readonly sourceAttemptId: string;
			readonly reference: ProviderTurnReference;
		}
	>;
	readonly attemptProviderTurns: ReadonlyMap<string, ProviderTurnReference>;
	/** Highest turn ordinal issued so far. */
	readonly turnCount: number;
	/** Derived from `turns`: the one turn that is not terminal, if any. */
	readonly currentTurnId: string | null;
	readonly currentTurnPhase: TurnPhase | null;
	readonly lastSettledTurnId: string | null;
	readonly lastSettlementOutcome: "completed" | "interrupted" | "error" | null;
	readonly settledTurnIds: ReadonlySet<string>;
	readonly queuedTurns: ReadonlyMap<string, QueuedTurn>;
	readonly queueOrder: ReadonlyArray<string>;
	readonly scheduledSuccessor: ScheduledSuccessor | null;
	readonly openSegments: ReadonlyMap<string, OpenSegment>;
	readonly messageIds: ReadonlySet<string>;
	readonly messageCheckpoints: ReadonlyMap<string, MessageCheckpointState>;
	readonly pendingPermissionIds: ReadonlySet<string>;
	readonly expiredPermissionIds: ReadonlySet<string>;
	readonly expiredQuestionIds: ReadonlySet<string>;
	readonly expiredPlanIds: ReadonlySet<string>;
	readonly resolvedQuestionIds: ReadonlySet<string>;
	readonly providerId: string | null;
	readonly attachedProviderId: string | null;
	readonly attachedProviderSessionId: string | null;
	readonly providerReservation: {
		readonly providerId: string;
		readonly providerSessionId: string;
	} | null;
	readonly version: number;
};

export const initialSessionState: SessionState = {
	exists: false,
	sessionId: null,
	chatId: null,
	projectId: null,
	title: null,
	titleProvenance: "manual",
	model: null,
	status: null,
	queuePaused: false,
	runtimeMode: null,
	worktreeId: null,
	permissionMode: null,
	archived: false,
	deleted: false,
	providerThreads: new Map(),
	activeProviderThreadId: null,
	turns: new Map(),
	attemptProviderTurns: new Map(),
	attemptRecoveries: new Map(),
	turnCount: 0,
	currentTurnId: null,
	currentTurnPhase: null,
	lastSettledTurnId: null,
	lastSettlementOutcome: null,
	settledTurnIds: new Set(),
	queuedTurns: new Map(),
	queueOrder: [],
	scheduledSuccessor: null,
	openSegments: new Map(),
	messageIds: new Set(),
	messageCheckpoints: new Map(),
	pendingPermissionIds: new Set(),
	expiredPermissionIds: new Set(),
	expiredQuestionIds: new Set(),
	expiredPlanIds: new Set(),
	resolvedQuestionIds: new Set(),
	providerId: null,
	attachedProviderId: null,
	attachedProviderSessionId: null,
	providerReservation: null,
	version: 0,
};

const added = <A>(source: ReadonlySet<A>, value: A): ReadonlySet<A> =>
	new Set([...source, value]);
const removed = <A>(source: ReadonlySet<A>, value: A): ReadonlySet<A> => {
	const next = new Set(source);
	next.delete(value);
	return next;
};

/** App id for a provider-native thread. Stable within the owning session for the same provider + native id. */
export const providerThreadIdFor = (
	sessionId: string,
	provider: string,
	nativeThreadId: string,
): string =>
	derive.providerThread({
		sessionId,
		provider: provider as Parameters<
			typeof derive.providerThread
		>[0]["provider"],
		nativeThreadId,
	});

export const attemptIdFor = (turnId: string, ordinal: number): string =>
	derive.attempt({ turnId, ordinal });

const withProviderThread = (
	state: SessionState,
	providerThread: ProviderThreadState,
	makeActive: boolean,
): Pick<SessionState, "providerThreads" | "activeProviderThreadId"> => {
	const providerThreads = new Map(state.providerThreads);
	providerThreads.set(providerThread.id, providerThread);
	return {
		providerThreads,
		activeProviderThreadId: makeActive
			? providerThread.id
			: state.activeProviderThreadId,
	};
};

/**
 * Legacy resume tokens (`cursor` on creation, `SessionResumeSet`) bind a
 * provider thread keyed by the session's provider so old event streams fold
 * into the same graph as new ones.
 */
const bindLegacyResume = (
	state: SessionState,
	nativeThreadId: string,
	nativeHeadId: string | null | undefined,
	at: number,
): Pick<SessionState, "providerThreads" | "activeProviderThreadId"> => {
	const provider = state.providerId ?? "unknown";
	const id = providerThreadIdFor(
		state.sessionId ?? "",
		provider,
		nativeThreadId,
	);
	const existing = state.providerThreads.get(id);
	const currentTurn =
		state.currentTurnId === null ? null : state.turns.get(state.currentTurnId);
	return withProviderThread(
		state,
		{
			id,
			provider,
			nativeThreadId,
			nativeHeadId:
				nativeHeadId === undefined
					? (existing?.nativeHeadId ?? null)
					: nativeHeadId,
			status: state.currentTurnId === null ? "idle" : "active",
			firstTurnOrdinal:
				existing?.firstTurnOrdinal ?? currentTurn?.ordinal ?? null,
			lastTurnOrdinal:
				currentTurn?.ordinal ?? existing?.lastTurnOrdinal ?? null,
			createdAt: existing?.createdAt ?? at,
			updatedAt: at,
		},
		true,
	);
};

/** Retire the active provider thread; the next turn opens a fresh one. */
const retireActiveProviderThread = (
	state: SessionState,
	at: number,
): Pick<SessionState, "providerThreads" | "activeProviderThreadId"> => {
	if (state.activeProviderThreadId === null) {
		return {
			providerThreads: state.providerThreads,
			activeProviderThreadId: null,
		};
	}
	const active = state.providerThreads.get(state.activeProviderThreadId);
	const providerThreads = new Map(state.providerThreads);
	if (active !== undefined) {
		providerThreads.set(active.id, {
			...active,
			status: "closed",
			updatedAt: at,
		});
	}
	return { providerThreads, activeProviderThreadId: null };
};

const withTurn = (
	state: SessionState,
	turn: TurnState,
): Pick<SessionState, "turns" | "turnCount"> => {
	const turns = new Map(state.turns);
	turns.set(turn.id, turn);
	return { turns, turnCount: Math.max(state.turnCount, turn.ordinal) };
};

const withTurnPhase = (
	state: SessionState,
	turnId: string,
	phase: TurnPhase,
): Pick<SessionState, "turns" | "currentTurnPhase"> => {
	const turn = state.turns.get(turnId);
	if (turn === undefined || state.currentTurnId !== turnId) {
		return { turns: state.turns, currentTurnPhase: state.currentTurnPhase };
	}
	const turns = new Map(state.turns);
	turns.set(turnId, { ...turn, phase });
	return { turns, currentTurnPhase: phase };
};

type MessageCollections = {
	readonly messageIds: Set<string>;
	readonly messageCheckpoints: Map<string, MessageCheckpointState>;
};

const evolveMessage = (
	state: SessionState,
	event: Extract<SessionEvent, { readonly _tag: "MessagePersisted" }>,
	version: number,
	owned?: MessageCollections,
): SessionState => {
	let expiredQuestionIds = state.expiredQuestionIds;
	let resolvedQuestionIds = state.resolvedQuestionIds;
	if (event.kind === "user_question_answer") {
		const decoded = decodeInputContent(event.contentJson);
		if (Result.isSuccess(decoded)) {
			const content = decoded.success;
			if (content._tag === "user_question_answer") {
				expiredQuestionIds = removed(expiredQuestionIds, content.itemId);
				resolvedQuestionIds = added(resolvedQuestionIds, content.itemId);
			}
		}
	}
	const messageCheckpoints =
		owned?.messageCheckpoints ?? new Map(state.messageCheckpoints);
	const messageIds = owned?.messageIds ?? new Set(state.messageIds);
	messageIds.add(event.messageId);
	if (event.checkpointRevision !== undefined) {
		messageCheckpoints.set(event.messageId, {
			revision: event.checkpointRevision,
			final: event.checkpointFinal === true,
		});
	}
	return {
		...state,
		expiredQuestionIds,
		resolvedQuestionIds,
		messageIds,
		messageCheckpoints,
		version,
	};
};

export const evolve = (
	state: SessionState,
	event: SessionEvent,
): SessionState => {
	const version = state.version + 1;
	switch (event._tag) {
		case "SessionCreated": {
			const created: SessionState = {
				...state,
				exists: true,
				sessionId: event.sessionId,
				chatId: event.chatId,
				projectId: event.projectId,
				title: event.title ?? null,
				titleProvenance: titleProvenanceOrManual(event.titleProvenance),
				providerId: event.providerId ?? null,
				model: event.model ?? null,
				status: event.status ?? null,
				runtimeMode: event.runtimeMode ?? null,
				worktreeId: event.worktreeId ?? null,
				permissionMode: event.permissionMode ?? null,
				queuePaused: event.queuePaused ?? false,
				version,
			};
			const legacyCursor = event.cursor ?? null;
			return legacyCursor === null
				? created
				: {
						...created,
						...bindLegacyResume(created, legacyCursor, null, event.createdAt),
					};
		}
		case "SessionTitleSet":
			return {
				...state,
				title: event.title,
				titleProvenance: titleProvenanceOrManual(event.titleProvenance),
				version,
			};
		case "SessionModelSet":
			return {
				...state,
				model: event.model,
				attachedProviderId: null,
				attachedProviderSessionId: null,
				providerReservation: null,
				version,
			};
		case "SessionProviderSet":
			// A different provider cannot continue this provider thread.
			return {
				...state,
				providerId: event.providerId,
				model: event.model,
				attachedProviderId: null,
				attachedProviderSessionId: null,
				providerReservation: null,
				...retireActiveProviderThread(state, event.updatedAt),
				version,
			};
		case "SessionRuntimeModeSet":
			return { ...state, runtimeMode: event.runtimeMode, version };
		case "SessionPermissionModeSet":
			return { ...state, permissionMode: event.permissionMode, version };
		case "SessionWorktreeSet":
			return {
				...state,
				worktreeId: event.worktreeId,
				providerReservation:
					state.worktreeId === event.worktreeId
						? state.providerReservation
						: null,
				...(state.worktreeId === event.worktreeId
					? {}
					: retireActiveProviderThread(state, event.updatedAt)),
				version,
			};
		case "SessionStatusSet": {
			// The provider accepted the turn: it is running, not merely starting.
			const current =
				state.currentTurnId === null
					? undefined
					: state.turns.get(state.currentTurnId);
			if (
				event.status === "running" &&
				current !== undefined &&
				current.status === "starting"
			) {
				return {
					...state,
					status: event.status,
					...withTurn(state, { ...current, status: "running" }),
					version,
				};
			}
			return { ...state, status: event.status, version };
		}
		case "SessionQueuePausedSet":
			return { ...state, queuePaused: event.paused, version };
		case "SessionResumeSet":
			return {
				...state,
				...bindLegacyResume(
					state,
					event.cursor ?? "",
					event.providerEventCursor,
					event.updatedAt,
				),
				version,
			};
		case "ProviderThreadUpdated": {
			const id = scopeProviderThreadId(
				state.sessionId ?? "",
				event.providerThread.id,
			);
			const previous = state.providerThreads.get(id);
			return {
				...state,
				...withProviderThread(
					state,
					{
						...event.providerThread,
						id,
						createdAt: previous?.createdAt ?? event.providerThread.createdAt,
					},
					false,
				),
				version,
			};
		}
		case "ActiveProviderThreadSet":
			return {
				...state,
				activeProviderThreadId:
					event.providerThreadId === null
						? null
						: scopeProviderThreadId(
								state.sessionId ?? "",
								event.providerThreadId,
							),
				version,
			};
		case "SessionArchived":
			return { ...state, archived: true, providerReservation: null, version };
		case "SessionUnarchived":
			return { ...state, archived: false, version };
		case "SessionDeleted":
			return { ...state, deleted: true, providerReservation: null, version };
		case "TurnStarted": {
			const ordinal = event.ordinal ?? state.turnCount + 1;
			const attemptId = event.attemptId ?? attemptIdFor(event.turnId, 1);
			const providerThreadId =
				event.providerThreadId === undefined
					? state.activeProviderThreadId
					: event.providerThreadId === null
						? null
						: scopeProviderThreadId(
								state.sessionId ?? "",
								event.providerThreadId,
							);
			const turn: TurnState = {
				id: event.turnId,
				ordinal,
				status: "starting",
				phase: "running",
				providerThreadId,
				activeAttemptId: attemptId,
				attempts: new Map([
					[
						attemptId,
						{
							id: attemptId,
							ordinal: 1,
							reason: "initial",
							status: "running",
							startedAt: event.startedAt,
							completedAt: null,
						},
					],
				]),
				requestedAt: event.startedAt,
				completedAt: null,
			};
			const thread =
				providerThreadId === null
					? undefined
					: state.providerThreads.get(providerThreadId);
			return {
				...state,
				...withTurn(state, turn),
				...(thread === undefined
					? {}
					: withProviderThread(
							state,
							{
								...thread,
								status: "active",
								firstTurnOrdinal: thread.firstTurnOrdinal ?? ordinal,
								lastTurnOrdinal: ordinal,
								updatedAt: event.startedAt,
							},
							false,
						)),
				currentTurnId: event.turnId,
				currentTurnPhase: "running",
				version,
			};
		}
		case "AttemptProviderTurnBound": {
			const attempt = state.turns
				.get(event.turnId)
				?.attempts.get(event.attemptId);
			if (
				attempt === undefined ||
				state.attemptProviderTurns.has(event.attemptId)
			)
				return { ...state, version };
			const attemptProviderTurns = new Map(state.attemptProviderTurns);
			attemptProviderTurns.set(event.attemptId, event.reference);
			return { ...state, attemptProviderTurns, version };
		}
		case "AttemptStarted": {
			const turn = state.turns.get(event.turnId);
			if (turn === undefined) return { ...state, version };
			const attempts = new Map(turn.attempts);
			const previous = attempts.get(turn.activeAttemptId);
			if (previous !== undefined && previous.status === "running") {
				attempts.set(previous.id, {
					...previous,
					status: "superseded",
					completedAt: event.startedAt,
				});
			}
			attempts.set(event.attemptId, {
				id: event.attemptId,
				ordinal: event.ordinal,
				reason: event.reason,
				status: "running",
				startedAt: event.startedAt,
				completedAt: null,
			});
			return {
				...state,
				...withTurn(state, {
					...turn,
					status: "starting",
					phase: "running",
					activeAttemptId: event.attemptId,
					attempts,
				}),
				currentTurnPhase:
					state.currentTurnId === event.turnId
						? "running"
						: state.currentTurnPhase,
				version,
			};
		}
		case "ProviderRecoveryRequested": {
			const attemptRecoveries = new Map(state.attemptRecoveries);
			attemptRecoveries.set(event.attemptId, {
				sourceAttemptId: event.sourceAttemptId,
				reference: event.reference,
			});
			return { ...state, attemptRecoveries, version };
		}
		case "ProviderTurnRequested":
			return { ...state, version };
		case "TurnInterruptRequested":
			return {
				...state,
				...withTurnPhase(state, event.turnId, "interrupt-requested"),
				version,
			};
		case "TurnInterruptAcknowledged":
			return {
				...state,
				...withTurnPhase(state, event.turnId, "interrupt-acknowledged"),
				version,
			};
		case "TurnInterruptFailed":
			return {
				...state,
				...withTurnPhase(state, event.turnId, "running"),
				version,
			};
		case "TurnsRolledBack": {
			const turns = new Map(state.turns);
			const messageIds = new Set(state.messageIds);
			const messageCheckpoints = new Map(state.messageCheckpoints);
			for (const id of event.removedMessageIds) {
				messageIds.delete(id);
				messageCheckpoints.delete(id);
			}
			const providerThreads = new Map(state.providerThreads);
			for (const [id, thread] of providerThreads)
				providerThreads.set(id, {
					...thread,
					status: "closed",
					updatedAt: event.rolledBackAt,
				});
			for (const [id, turn] of turns)
				if (turn.ordinal > event.throughOrdinal)
					turns.set(id, { ...turn, status: "rolled_back" });
			return {
				...state,
				turns,
				messageIds,
				messageCheckpoints,
				providerThreads,
				pendingPermissionIds: new Set(),
				expiredPermissionIds: new Set([
					...state.expiredPermissionIds,
					...state.pendingPermissionIds,
				]),
				activeProviderThreadId: null,
				lastSettledTurnId: null,
				lastSettlementOutcome: null,
				version,
			};
		}
		case "TurnFinalizationRequested": {
			const turn = state.turns.get(event.turnId);
			return turn === undefined
				? { ...state, version }
				: {
						...state,
						...withTurn(state, { ...turn, status: "finalizing" }),
						version,
					};
		}
		case "TurnSettled": {
			const turn = state.turns.get(event.turnId);
			const turnStatus: TurnStatus =
				event.outcome === "completed"
					? "completed"
					: event.outcome === "interrupted"
						? "interrupted"
						: "failed";
			let turns = state.turns;
			if (turn !== undefined) {
				const attempts = new Map(turn.attempts);
				const active = attempts.get(turn.activeAttemptId);
				if (active !== undefined) {
					attempts.set(active.id, {
						...active,
						status: turnStatus,
						completedAt: event.settledAt,
					});
				}
				turns = withTurn(state, {
					...turn,
					status: turnStatus,
					phase: null,
					attempts,
					completedAt: event.settledAt,
				}).turns;
			}
			const activeThread =
				state.activeProviderThreadId === null
					? undefined
					: state.providerThreads.get(state.activeProviderThreadId);
			return {
				...state,
				turns,
				...(activeThread === undefined || activeThread.status !== "active"
					? {}
					: withProviderThread(
							state,
							{ ...activeThread, status: "idle", updatedAt: event.settledAt },
							false,
						)),
				currentTurnId: null,
				currentTurnPhase: null,
				lastSettledTurnId: event.turnId,
				lastSettlementOutcome: event.outcome,
				settledTurnIds: added(state.settledTurnIds, event.turnId),
				version,
			};
		}
		case "QueuedTurnEnqueued": {
			const queuedTurns = new Map(state.queuedTurns);
			queuedTurns.set(event.queueId, event);
			return {
				...state,
				queuedTurns,
				queueOrder: [...state.queueOrder, event.queueId],
				version,
			};
		}
		case "QueuedTurnUpdated": {
			const current = state.queuedTurns.get(event.queueId);
			if (current === undefined) return { ...state, version };
			const queuedTurns = new Map(state.queuedTurns);
			queuedTurns.set(event.queueId, {
				...current,
				inputJson: event.inputJson,
				ready: event.ready,
			});
			return { ...state, queuedTurns, version };
		}
		case "QueuedTurnRemoved":
		case "QueuedTurnClaimed": {
			const queuedTurns = new Map(state.queuedTurns);
			queuedTurns.delete(event.queueId);
			return {
				...state,
				queuedTurns,
				queueOrder: state.queueOrder.filter((id) => id !== event.queueId),
				version,
			};
		}
		case "QueuedTurnsReordered":
			return { ...state, queueOrder: event.queueIds, version };
		case "SuccessorTurnScheduled":
			return {
				...state,
				scheduledSuccessor: {
					predecessorTurnId: event.predecessorTurnId,
					turnId: event.turnId,
					queueId: event.queueId,
					inputJson: event.inputJson,
				},
				version,
			};
		case "ScheduledSuccessorReady":
			return { ...state, scheduledSuccessor: null, version };
		case "MessagePersisted":
			return evolveMessage(state, event, version);
		case "SegmentOpened": {
			const openSegments = new Map(state.openSegments);
			openSegments.set(event.segmentId, {
				turnId: event.turnId,
				kind: event.kind,
			});
			return { ...state, openSegments, version };
		}
		case "SegmentSettled": {
			const openSegments = new Map(state.openSegments);
			openSegments.delete(event.segmentId);
			return { ...state, openSegments, version };
		}
		case "PermissionRequested":
			return {
				...state,
				pendingPermissionIds: added(
					state.pendingPermissionIds,
					event.requestId,
				),
				version,
			};
		case "PermissionExpired":
			return {
				...state,
				expiredPermissionIds: added(
					state.expiredPermissionIds,
					event.requestId,
				),
				version,
			};
		case "PermissionResolved":
			return {
				...state,
				expiredPermissionIds: removed(
					state.expiredPermissionIds,
					event.requestId,
				),
				pendingPermissionIds: removed(
					state.pendingPermissionIds,
					event.requestId,
				),
				version,
			};
		case "PlanExpired":
			return {
				...state,
				expiredPlanIds: added(state.expiredPlanIds, event.itemId),
				version,
			};
		case "QuestionExpired":
			return {
				...state,
				expiredQuestionIds: added(state.expiredQuestionIds, event.itemId),
				version,
			};
		case "QuestionResolved":
			return {
				...state,
				expiredQuestionIds: removed(state.expiredQuestionIds, event.itemId),
				resolvedQuestionIds: added(state.resolvedQuestionIds, event.itemId),
				version,
			};
		case "ProviderSessionReserved":
			return {
				...state,
				providerReservation: {
					providerId: event.providerId,
					providerSessionId: event.providerSessionId,
				},
				version,
			};
		case "ProviderAttached":
			return {
				...state,
				attachedProviderId: event.providerId,
				attachedProviderSessionId: event.providerSessionId ?? null,
				providerReservation:
					state.providerReservation?.providerSessionId ===
					event.providerSessionId
						? state.providerReservation
						: null,
				version,
			};
		case "ProviderStopRequested":
			return {
				...state,
				providerReservation:
					state.providerReservation?.providerSessionId ===
					event.providerSessionId
						? null
						: state.providerReservation,
				version,
			};
		case "ProviderDetached":
			return {
				...state,
				attachedProviderId: null,
				attachedProviderSessionId: null,
				providerReservation:
					state.providerReservation?.providerSessionId ===
					event.providerSessionId
						? null
						: state.providerReservation,
				version,
			};
	}
};

export const evolveAll = (
	state: SessionState,
	events: readonly SessionEvent[],
): SessionState => {
	let current = state;
	let owned: MessageCollections | undefined;
	for (const event of events) {
		if (event._tag !== "MessagePersisted") {
			current = evolve(current, event);
			owned = undefined;
			continue;
		}
		// Only this synchronous fold can observe its intermediate states. Copy
		// once per contiguous message batch, avoiding quadratic transcript replay
		// while keeping the supplied state and ordinary evolve calls immutable.
		owned ??= {
			messageIds: new Set(current.messageIds),
			messageCheckpoints: new Map(current.messageCheckpoints),
		};
		current = evolveMessage(current, event, current.version + 1, owned);
	}
	return current;
};

/** The active provider thread, when one is bound. */
export const activeProviderThread = (
	state: SessionState,
): ProviderThreadState | null =>
	state.activeProviderThreadId === null
		? null
		: (state.providerThreads.get(state.activeProviderThreadId) ?? null);
