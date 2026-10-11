import { SessionTimelineTurnPhase } from "@zuse/contracts";
import { Predicate, Schema } from "effect";

const LegacyTurn = Schema.Struct({
	turnId: Schema.String,
	phase: SessionTimelineTurnPhase,
});
const isLegacyTurn = Schema.is(LegacyTurn);
const isLegacySession = Schema.is(
	Schema.Struct({
		id: Schema.String,
		projectId: Schema.String,
		providerId: Schema.String,
		model: Schema.String,
		cursor: Schema.NullOr(Schema.String),
		resumeStrategy: Schema.String,
	}),
);

/**
 * Protocols 5/6 expose a turn identity and interrupt phase, not engine attempts.
 * These sentinel fields satisfy the presentation contract only. They must never
 * be used for checkpoints, retries, or other protocol-7 engine operations.
 * Zero denotes unavailable ordinal/time rather than an invented historical turn.
 */
const presentationTurn = (turn: typeof LegacyTurn.Type) => ({
	id: turn.turnId,
	ordinal: 0,
	status:
		turn.phase === "requested" || turn.phase === "starting"
			? "starting"
			: "running",
	phase: turn.phase,
	attempt: { id: `legacy:${turn.turnId}`, ordinal: 0, reason: "initial" },
	providerThreadId: null,
	requestedAt: "1970-01-01T00:00:00.000Z",
	completedAt: null,
});

/**
 * Translate encoded legacy responses before the current RPC schemas decode them.
 * Traverse only transport envelopes and known session containers: tool results,
 * message content, and arbitrary provider data must remain byte-for-byte intact.
 * The old runtime retains ownership of its provider cursor and resume strategy;
 * no durable engine thread is fabricated for it in the client.
 */
export const normalizeLegacyRuntimeResponse = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(normalizeLegacyRuntimeResponse);
	if (!Predicate.isObject(value)) return value;

	if (isLegacySession(value) && !("providerThread" in value)) {
		return { ...value, providerThread: null };
	}
	if (
		"currentTurn" in value &&
		!("activeTurn" in value) &&
		Array.isArray(value.messages) &&
		"queue" in value &&
		"permissionMode" in value
	) {
		return {
			...value,
			activeTurn:
				value.currentTurn === null
					? null
					: presentationTurn(
							Schema.decodeUnknownSync(LegacyTurn)(value.currentTurn),
						),
			turnCount: 0,
		};
	}
	if (
		value._tag === "TurnStarted" &&
		!("turn" in value) &&
		isLegacyTurn(value)
	) {
		return { ...value, turn: presentationTurn(value) };
	}

	// Effect RPC JSON envelopes. Do not descend into arbitrary error/defect data.
	if (value._tag === "Exit" && "exit" in value) {
		return { ...value, exit: normalizeLegacyRuntimeResponse(value.exit) };
	}
	if (value._tag === "Success" && "value" in value) {
		return { ...value, value: normalizeLegacyRuntimeResponse(value.value) };
	}
	if (value._tag === "Chunk" && Array.isArray(value.values)) {
		return {
			...value,
			values: value.values.map(normalizeLegacyRuntimeResponse),
		};
	}

	if (value.kind === "snapshot" && "projection" in value) {
		return {
			...value,
			projection: normalizeLegacyRuntimeResponse(value.projection),
		};
	}
	if (value.kind === "event" && "event" in value) {
		return { ...value, event: normalizeLegacyRuntimeResponse(value.event) };
	}
	// session.streamChanges, chat.get, externalThread.import and session reads.
	if ("session" in value) {
		return { ...value, session: normalizeLegacyRuntimeResponse(value.session) };
	}
	if (Array.isArray(value.sessions)) {
		return {
			...value,
			sessions: value.sessions.map(normalizeLegacyRuntimeResponse),
		};
	}
	return value;
};
