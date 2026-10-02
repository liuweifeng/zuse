import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	Attempt,
	Checkpoint,
	ContextHandoff,
	ContextLink,
	InputRequest,
	isActiveTurnStatus,
	isTerminalTurnStatus,
	ProviderCapabilities,
	ProviderThread,
	Step,
	TIMELINE_TURN_BAND,
	TimelineItem,
	Turn,
	timelineBandLowerBound,
	timelineBandUpperBound,
} from "../../src/index.ts";

/**
 * Every Agent Engine entity is persisted as an entity-snapshot event payload
 * and re-read on the wire, so encode∘decode must be the identity and malformed
 * rows must be rejected rather than silently accepted.
 */

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, encoded: I): void => {
	const decoded = Schema.decodeUnknownSync(schema)(encoded);
	const reEncoded = Schema.encodeSync(schema)(decoded);
	expect(reEncoded).toEqual(encoded);
};

const now = "2026-09-02T10:00:00.000Z";

const codexRef = {
	provider: "codex" as const,
	nativeId: "thread_abc",
	strength: "strong" as const,
};

describe("agent engine contracts", () => {
	it("round-trips a turn and its attempt", () => {
		roundTrip(Turn, {
			id: "turn:session:s_1:ordinal:1",
			sessionId: "s_1",
			ordinal: 1,
			provider: "codex",
			model: "gpt-5",
			providerThreadId:
				"provider-thread:provider:codex:native-thread:thread_abc",
			userMessageId: "m_1",
			rootStepId: "step:turn:turn_1:attempt:1:root",
			activeAttemptId: "attempt:turn:turn_1:ordinal:1",
			status: "running",
			queuePosition: null,
			requestedAt: now,
			startedAt: now,
			completedAt: null,
			checkpointId: null,
			contextHandoffId: null,
		});
		roundTrip(Attempt, {
			id: "attempt:turn:turn_1:ordinal:1",
			turnId: "turn:session:s_1:ordinal:1",
			ordinal: 1,
			rootStepId: "step:turn:turn_1:attempt:1:root",
			provider: "codex",
			providerThreadId: "pt_1",
			providerTurnId: null,
			reason: "initial",
			status: "running",
			leaseOwner: "server:1234",
			leaseExpiresAt: now,
			startedAt: now,
			completedAt: null,
		});
	});

	it("rejects a turn with a non-positive ordinal", () => {
		expect(() =>
			Schema.decodeUnknownSync(Turn)({
				id: "turn_1",
				sessionId: "s_1",
				ordinal: 0,
				provider: "codex",
				model: null,
				providerThreadId: null,
				userMessageId: "m_1",
				rootStepId: null,
				activeAttemptId: null,
				status: "queued",
				queuePosition: 1,
				requestedAt: now,
				startedAt: null,
				completedAt: null,
				checkpointId: null,
				contextHandoffId: null,
			}),
		).toThrow();
	});

	it("classifies turn statuses", () => {
		expect(isActiveTurnStatus("running")).toBe(true);
		expect(isActiveTurnStatus("finalizing")).toBe(true);
		expect(isActiveTurnStatus("queued")).toBe(false);
		expect(isTerminalTurnStatus("rolled_back")).toBe(true);
		expect(isTerminalTurnStatus("finalizing")).toBe(false);
	});

	it("round-trips a step and a provider thread with native refs", () => {
		roundTrip(Step, {
			id: "step_1",
			sessionId: "s_1",
			turnId: "turn_1",
			parentStepId: null,
			rootStepId: "step_1",
			kind: "root",
			status: "running",
			completesTurn: true,
			providerThreadId: "pt_1",
			providerTurnId: "turn_1",
			nativeItemRef: null,
			inputRequestId: null,
			checkpointScopeId: "scope_1",
			startedAt: now,
			completedAt: null,
		});
		roundTrip(ProviderThread, {
			id: "pt_1",
			provider: "codex",
			providerSessionId: "ps_1",
			sessionId: "s_1",
			ownerStepId: null,
			nativeThreadRef: codexRef,
			nativeHeadRef: null,
			status: "active",
			firstTurnOrdinal: 1,
			lastTurnOrdinal: 5,
			handoffIds: ["handoff_1"],
			forkedFrom: null,
			backgroundTasks: [{ taskId: "bg_1", description: "tests" }],
			createdAt: now,
			updatedAt: now,
		});
	});

	it("round-trips input requests in both live and expired forms", () => {
		roundTrip(InputRequest, {
			id: "req_1",
			sessionId: "s_1",
			stepId: "step_1",
			providerTurnId: "turn_1",
			nativeRequestRef: {
				provider: "claude",
				nativeId: "tool_1",
				strength: "weak",
			},
			kind: {
				_tag: "permission",
				permission: { _tag: "Bash", command: "rm -rf build" },
			},
			status: "pending",
			answerability: { _tag: "live", providerSessionId: "ps_1" },
			createdAt: now,
			answeredAt: null,
		});
		roundTrip(InputRequest, {
			id: "req_2",
			sessionId: "s_1",
			stepId: "step_2",
			providerTurnId: null,
			nativeRequestRef: null,
			kind: {
				_tag: "question",
				questions: [{ question: "Which one?", options: ["a", "b"] }],
			},
			status: "expired",
			answerability: {
				_tag: "expired",
				reason: "The server restarted before this request was answered.",
			},
			createdAt: now,
			answeredAt: null,
		});
	});

	it("round-trips context links, handoffs, and checkpoints", () => {
		roundTrip(ContextLink, {
			id: "link_1",
			type: "fork",
			sourceSessionId: "s_1",
			targetSessionId: "s_2",
			sourcePoint: { sessionId: "s_1", turnId: "turn_3" },
			basePoint: null,
			sourceProvider: "codex",
			targetProvider: null,
			status: "pending",
			resolution: null,
			error: null,
			createdBy: "user",
			createdAt: now,
			consumedAt: null,
		});
		roundTrip(ContextHandoff, {
			id: "handoff_1",
			linkId: "link_2",
			sessionId: "s_1",
			targetTurnId: "turn_6",
			fromProviderThreadIds: ["pt_1"],
			toProviderThreadId: "pt_2",
			coveredTurnOrdinals: { from: 1, to: 5 },
			strategy: "full_session",
			status: "ready",
			summaryMessageId: null,
			summaryText: "Turns 1-5 changed the auth module.",
			createdByProvider: null,
			createdAt: now,
			updatedAt: now,
		});
		roundTrip(Checkpoint, {
			id: "checkpoint:scope:scope_1:ordinal:2",
			sessionId: "s_1",
			scopeId: "scope_1",
			turnId: "turn_2",
			stepId: "step_1",
			parentCheckpointId: null,
			ordinalWithinScope: 2,
			turnOrdinal: 2,
			ref: "refs/zuse/checkpoints/abc/ordinal/2",
			status: "ready",
			files: [
				{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
			],
			capturedAt: now,
		});
	});

	it("round-trips timeline items and keeps turn bands disjoint", () => {
		roundTrip(TimelineItem, {
			_tag: "user_message",
			id: "timeline:user-message:m_1",
			sessionId: "s_1",
			turnId: "turn_1",
			stepId: null,
			providerThreadId: null,
			providerTurnId: null,
			nativeItemRef: null,
			parentItemId: null,
			ordinal: timelineBandLowerBound(1) + 1,
			status: "completed",
			title: null,
			startedAt: null,
			completedAt: null,
			updatedAt: now,
			messageId: "m_1",
			intent: "turn_start",
			text: "Fix the failing test",
			attachments: [],
		});
		expect(timelineBandUpperBound(1)).toBeLessThan(timelineBandLowerBound(2));
		expect(timelineBandLowerBound(null)).toBe(0);
		expect(timelineBandUpperBound(null)).toBe(TIMELINE_TURN_BAND - 1);
	});

	it("requires every capability group", () => {
		expect(() =>
			Schema.decodeUnknownSync(ProviderCapabilities)({ session: {} }),
		).toThrow();
	});
});
