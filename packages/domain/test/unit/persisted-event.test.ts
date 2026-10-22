import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { SessionEvent } from "../../src/core/events.ts";
import { decodePersistedEvent } from "../../src/engine/persisted-event.ts";

it("replays a saved Pi resume event without blocking startup or losing its cursor", async () => {
	const event = {
		_tag: "SessionResumeSet",
		cursor: "/sessions/saved-session.jsonl",
		resumeStrategy: "pi-session-file",
		updatedAt: 1,
	};
	const stored = await Effect.runPromise(
		decodePersistedEvent(
			{
				sequence: 1,
				event_id: "saved-pi-resume",
				correlation_id: null,
				causation_event_id: null,
				stream_id: "saved-session",
				stream_version: 1,
				payload_json: JSON.stringify(event),
			},
			Schema.decodeUnknownEffect(Schema.fromJsonString(SessionEvent)),
		),
	);
	expect(stored.event).toEqual(event);
});
