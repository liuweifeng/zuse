import {
	AgentTurnId,
	AttemptId,
	ComposerInput,
	Message,
	MessageContent,
	MessageId,
	MessageRole,
	PermissionRequest,
	QueuedMessage,
	QueuedMessageInput,
	type SessionId,
	type SessionTimelineEvent,
	type SessionTurn,
} from "@zuse/contracts";
import { Result, Schema } from "effect";
import { scopeProviderThreadId } from "../agent-engine/ids.js";
import type { SessionEvent as SessionDomainEvent } from "../core/events.js";

export {
	applyTimelineEvent,
	emptyTimelineProjection,
} from "./timeline-reducer.js";

const decodeContent = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);
const decodeRole = Schema.decodeUnknownResult(MessageRole);
const decodeComposerInput = Schema.decodeUnknownResult(
	Schema.fromJsonString(QueuedMessageInput),
);
const decodePermissionRequest = Schema.decodeUnknownResult(
	Schema.fromJsonString(PermissionRequest),
);

export const timelineEventFromDomain = (
	sessionId: SessionId,
	event: SessionDomainEvent,
): SessionTimelineEvent => {
	switch (event._tag) {
		case "MessagePersisted": {
			const content = decodeContent(event.contentJson);
			const role = decodeRole(event.role);
			if (Result.isFailure(content) || Result.isFailure(role)) {
				return { _tag: "Noop" };
			}
			return {
				_tag: "MessagePersisted",
				message: Message.make({
					id: MessageId.make(event.messageId),
					sessionId,
					role: role.success,
					content: content.success,
					createdAt: new Date(event.createdAt),
				}),
			};
		}
		case "SessionStatusSet":
			return { _tag: "StatusSet", status: event.status };
		case "TurnStarted": {
			const turn: SessionTurn = {
				id: AgentTurnId.make(event.turnId),
				ordinal: event.ordinal ?? 0,
				status: "starting",
				phase: "running",
				attempt: {
					id: AttemptId.make(
						event.attemptId ?? `attempt:turn:${event.turnId}:ordinal:1`,
					),
					ordinal: 1,
					reason: "initial",
				},
				providerThreadId:
					event.providerThreadId === undefined ||
					event.providerThreadId === null
						? null
						: scopeProviderThreadId(sessionId, event.providerThreadId),
				requestedAt: new Date(event.startedAt),
				completedAt: null,
			};
			return { _tag: "TurnStarted", turn };
		}
		case "AttemptStarted": {
			const turn: SessionTurn = {
				id: AgentTurnId.make(event.turnId),
				ordinal: event.turnOrdinal,
				status: "starting",
				phase: "running",
				attempt: {
					id: AttemptId.make(event.attemptId),
					ordinal: event.ordinal,
					reason: event.reason,
				},
				providerThreadId:
					event.providerThreadId === null
						? null
						: scopeProviderThreadId(sessionId, event.providerThreadId),
				requestedAt: new Date(event.turnRequestedAt),
				completedAt: null,
			};
			return { _tag: "TurnUpdated", turn };
		}
		case "TurnInterruptRequested":
			return {
				_tag: "TurnPhaseSet",
				turnId: AgentTurnId.make(event.turnId),
				phase: "interrupt-requested",
			};
		case "TurnInterruptAcknowledged":
			return {
				_tag: "TurnPhaseSet",
				turnId: AgentTurnId.make(event.turnId),
				phase: "interrupt-acknowledged",
			};
		case "TurnInterruptFailed":
			return {
				_tag: "TurnPhaseSet",
				turnId: AgentTurnId.make(event.turnId),
				phase: "running",
			};
		case "TurnSettled":
			return {
				_tag: "TurnSettled",
				turnId: AgentTurnId.make(event.turnId),
				outcome: event.outcome,
			};
		case "SessionPermissionModeSet":
			return {
				_tag: "PermissionModeSet",
				permissionMode: event.permissionMode,
			};
		case "SessionRuntimeModeSet":
			return { _tag: "RuntimeModeSet", runtimeMode: event.runtimeMode };
		case "PermissionRequested": {
			const request = decodePermissionRequest(event.payloadJson);
			return Result.isFailure(request)
				? { _tag: "Noop" }
				: { _tag: "PermissionRequested", request: request.success };
		}
		case "PermissionExpired":
			return { _tag: "PermissionExpired", requestId: event.requestId };
		case "PermissionResolved":
			return { _tag: "PermissionResolved", requestId: event.requestId };
		case "QuestionResolved":
			return {
				_tag: "QuestionResolved",
				itemId: event.itemId as import("@zuse/contracts").AgentItemId,
				resolution: event.resolution,
			};
		case "SessionQueuePausedSet":
			return { _tag: "QueuePausedSet", paused: event.paused };
		case "QueuedTurnEnqueued": {
			const input = decodeComposerInput(event.inputJson);
			return Result.isFailure(input)
				? { _tag: "Noop" }
				: {
						_tag: "QueueEnqueued",
						item: QueuedMessage.make({
							id: event.queueId,
							sessionId,
							input: input.success,
							actor: input.success.actor,
							position: event.position,
							createdAt: new Date(event.createdAt),
							updatedAt: new Date(event.createdAt),
							ready: event.ready,
						}),
					};
		}
		case "QueuedTurnUpdated": {
			const input = decodeComposerInput(event.inputJson);
			return Result.isFailure(input)
				? { _tag: "Noop" }
				: {
						_tag: "QueueUpdated",
						queueId: event.queueId,
						input: input.success,
						updatedAt: new Date(event.updatedAt),
						ready: event.ready,
					};
		}
		case "QueuedTurnRemoved":
		case "QueuedTurnClaimed":
			return { _tag: "QueueRemoved", queueId: event.queueId };
		case "QueuedTurnsReordered":
			return { _tag: "QueueReordered", queueIds: event.queueIds };
		default:
			return { _tag: "Noop" };
	}
};
