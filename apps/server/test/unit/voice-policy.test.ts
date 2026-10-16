import { describe, expect, it } from "vitest";

import {
	classifyVoiceFallback,
	MAX_VOICE_BYTES,
	voiceRecordingFilename,
	voiceValidationReason,
} from "../../src/voice/policy.ts";

describe("voice transcription policy", () => {
	it("accepts browser audio and preserves its file format for the provider", () => {
		expect(
			voiceValidationReason(new Uint8Array([1]), "audio/webm", 1000),
		).toBeNull();
		expect(voiceRecordingFilename("audio/webm")).toBe("recording.webm");
		expect(voiceRecordingFilename("audio/mp4")).toBe("recording.m4a");
		expect(voiceRecordingFilename("text/plain")).toBeNull();
		expect(voiceRecordingFilename("constructor")).toBeNull();
	});

	it("permits credential fallback only for classified provider failures", () => {
		expect(classifyVoiceFallback(401, "")).toBe("authentication-rejected");
		expect(classifyVoiceFallback(403, "Cloudflare challenge")).toBe("blocked");
		expect(classifyVoiceFallback(415, "")).toBe("unsupported");
		expect(classifyVoiceFallback(429, "rate limited")).toBeNull();
		expect(classifyVoiceFallback(500, "token=secret")).toBeNull();
	});

	it("rejects validation failures before account fallback", () => {
		expect(voiceValidationReason(new Uint8Array(), "audio/mp4", 1_000)).toBe(
			"Recording is empty.",
		);
		expect(
			voiceValidationReason(
				new Uint8Array(MAX_VOICE_BYTES + 1),
				"audio/mp4",
				1_000,
			),
		).toContain("10 MB");
		expect(
			voiceValidationReason(new Uint8Array([1]), "text/plain", 1_000),
		).toContain("format");
	});
});
