import {
	Session,
	SessionSetProviderRpc,
	SessionSummaryChange,
	SessionTimelineFrame,
} from "@zuse/contracts";
import { applyTimelineEvent } from "@zuse/domain/projectors/timeline-reducer";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { normalizeLegacyRuntimeResponse } from "../../src/legacy-runtime-response.ts";

// Wire shapes from origin/main (protocol 6) and a80cb4bdf^ (protocol 5).
const legacySession = {
	id: "session-old",
	projectId: "project-old",
	title: "Existing chat",
	titleProvenance: "manual",
	providerId: "codex",
	model: "gpt-5",
	status: "running",
	archivedAt: null,
	cursor: "original-provider-conversation",
	resumeStrategy: "codex-thread-id",
	runtimeMode: "approval-required",
	worktreeId: null,
	chatId: "chat-old",
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
};
const legacySnapshot = {
	kind: "snapshot",
	sessionId: "session-old",
	throughVersion: 10,
	cursor: { epoch: "database-old", version: 10 },
	projection: {
		messages: [],
		status: "running",
		currentTurn: { turnId: "turn-real", phase: "running" },
		queue: { items: [], paused: false },
		permissionMode: "default",
		runtimeMode: "approval-required",
		interactions: [],
	},
};
const decodeFrame = (value: unknown) =>
	Schema.decodeUnknownSync(SessionTimelineFrame)(
		normalizeLegacyRuntimeResponse(value),
	);

describe("legacy runtime response translation", () => {
	it("decodes an existing session without fabricating a provider thread", () => {
		const decoded = Schema.decodeUnknownSync(Session)(
			normalizeLegacyRuntimeResponse(legacySession),
		);
		expect(decoded.id).toBe("session-old");
		expect(decoded.providerThread).toBeNull();
		expect(legacySession.cursor).toBe("original-provider-conversation");
	});
	it("preserves exact turn identity and interrupt phase across reconnect snapshots", () => {
		const frame = decodeFrame(legacySnapshot);
		expect(frame.kind).toBe("snapshot");
		if (frame.kind !== "snapshot") throw new Error("Expected snapshot");
		expect(frame.projection.activeTurn).toMatchObject({
			id: "turn-real",
			phase: "running",
			ordinal: 0,
		});
		expect(frame.cursor).toEqual(legacySnapshot.cursor);
		if (!frame.projection.activeTurn) throw new Error("Expected active turn");
		const interrupted = applyTimelineEvent(frame.projection, {
			_tag: "TurnPhaseSet",
			turnId: frame.projection.activeTurn.id,
			phase: "interrupt-requested",
		});
		expect(interrupted.activeTurn?.phase).toBe("interrupt-requested");
		const settled = applyTimelineEvent(interrupted, {
			_tag: "TurnSettled",
			turnId: frame.projection.activeTurn.id,
			outcome: "completed",
		});
		expect(settled.activeTurn).toBeNull();
		expect(settled.status).toBe("idle");
	});
	it("decodes streamed starts and idle snapshots through current schemas", () => {
		const started = decodeFrame({
			kind: "event",
			sessionId: "session-old",
			streamVersion: 11,
			eventId: "event-11",
			event: { _tag: "TurnStarted", turnId: "turn-next", phase: "running" },
		});
		expect(started).toMatchObject({
			event: { turn: { id: "turn-next", attempt: { id: "legacy:turn-next" } } },
		});
		const idle = decodeFrame({
			...legacySnapshot,
			projection: {
				...legacySnapshot.projection,
				status: "idle",
				currentTurn: null,
			},
		});
		expect(idle).toMatchObject({ projection: { activeTurn: null } });
	});
	it("normalizes actual RPC success, stream and session catalog envelopes", () => {
		const reply = normalizeLegacyRuntimeResponse({
			_tag: "Exit",
			requestId: "1",
			exit: { _tag: "Success", value: [legacySession] },
		});
		expect(reply).toMatchObject({
			exit: { value: [{ providerThread: null }] },
		});
		const chunk = normalizeLegacyRuntimeResponse({
			_tag: "Chunk",
			requestId: "2",
			values: [
				{ _tag: "change", sequence: 2, session: legacySession },
				{ _tag: "snapshot", cursor: 1, sessions: [legacySession] },
				legacySnapshot,
			],
		});
		expect(chunk).toMatchObject({
			values: [
				{ session: { providerThread: null } },
				{ sessions: [{ providerThread: null }] },
				{ projection: { activeTurn: { id: "turn-real" } } },
			],
		});
	});
	it("decodes legacy session catalog snapshots and incremental changes", () => {
		const decode = Schema.decodeUnknownSync(SessionSummaryChange);
		const snapshot = decode(
			normalizeLegacyRuntimeResponse({
				_tag: "snapshot",
				cursor: 20,
				sessions: [legacySession],
			}),
		);
		const change = decode(
			normalizeLegacyRuntimeResponse({
				_tag: "change",
				sequence: 21,
				session: legacySession,
			}),
		);
		expect(snapshot).toMatchObject({
			cursor: 20,
			sessions: [{ providerThread: null }],
		});
		expect(change).toMatchObject({
			sequence: 21,
			session: { providerThread: null },
		});
	});

	it("retains legacy provider-switch rejection for current error decoding", () => {
		const error = {
			_tag: "SessionAlreadyStartedError",
			sessionId: "session-old",
		};
		expect(
			Schema.decodeUnknownSync(SessionSetProviderRpc.errorSchema)(
				normalizeLegacyRuntimeResponse(error),
			),
		).toMatchObject(error);
	});

	it("never rewrites user messages, tool output, errors or current engine records", () => {
		const message = {
			id: "message",
			content: { _tag: "tool_result", result: legacySnapshot },
		};
		const current = { ...legacySession, providerThread: { id: "real-thread" } };
		const failure = {
			_tag: "Failure",
			cause: [{ _tag: "Fail", error: legacySnapshot }],
		};
		expect(normalizeLegacyRuntimeResponse(message)).toBe(message);
		expect(normalizeLegacyRuntimeResponse(current)).toBe(current);
		expect(normalizeLegacyRuntimeResponse(failure)).toBe(failure);
	});
	it("rejects malformed legacy turn data instead of showing fake idle state", () => {
		expect(() =>
			decodeFrame({
				...legacySnapshot,
				projection: {
					...legacySnapshot.projection,
					currentTurn: { turnId: 5, phase: "running" },
				},
			}),
		).toThrow();
	});
});
