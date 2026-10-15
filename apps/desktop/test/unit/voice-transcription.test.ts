import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, net: {} }));

const { parseVoiceTranscribeRequest } = await import(
	"../../src/voice-transcription.ts"
);

const valid = {
	token: "token",
	accountId: "account",
	bytes: new Uint8Array([1]),
	mimeType: "audio/webm",
};

describe("desktop voice transcription request", () => {
	it("accepts a bounded audio upload", () => {
		expect(parseVoiceTranscribeRequest(valid)).toEqual(valid);
		expect(
			parseVoiceTranscribeRequest({ ...valid, accountId: null }),
		).not.toBeNull();
	});
	it("rejects anything that is not a bounded audio upload", () => {
		for (const raw of [
			null,
			"token",
			{ ...valid, token: "" },
			{ ...valid, token: 1 },
			{ ...valid, accountId: undefined },
			{ ...valid, bytes: [1] },
			{ ...valid, bytes: new Uint8Array() },
			{ ...valid, bytes: new Uint8Array(10 * 1024 * 1024 + 1) },
			{ ...valid, mimeType: "text/html" },
		])
			expect(parseVoiceTranscribeRequest(raw)).toBeNull();
	});
});
