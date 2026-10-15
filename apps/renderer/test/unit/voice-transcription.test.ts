import { describe, expect, it, vi } from "vitest";
import { transcribeRecording } from "../../src/lib/voice-transcription";

const recording = {
	bytes: new Uint8Array([1]),
	mimeType: "audio/webm",
	durationMs: 1000,
};
const fallback = {
	_tag: "phoneFallbackRequired",
	reason: "blocked",
	ticket: "ticket",
} as const;
const setup = () => ({
	transcribe: vi.fn(async () => fallback as never),
	resolveAuth: vi.fn(async () => ({ token: "token", accountId: "account" })),
	direct: vi.fn(async () => ({ _tag: "transcribed", text: "hello" }) as const),
});

describe("recording transcription", () => {
	it("uses the engine transcript without touching credentials", async () => {
		const deps = setup();
		deps.transcribe.mockResolvedValue({
			_tag: "transcribed",
			text: "hi",
		} as never);
		await expect(transcribeRecording(recording, deps)).resolves.toBe("hi");
		expect(deps.resolveAuth).not.toHaveBeenCalled();
		expect(deps.direct).not.toHaveBeenCalled();
	});
	it("retries a rejected engine upload through the desktop shell", async () => {
		const deps = setup();
		await expect(transcribeRecording(recording, deps)).resolves.toBe("hello");
		expect(deps.resolveAuth).toHaveBeenCalledWith("ticket");
		expect(deps.direct).toHaveBeenCalledWith({
			token: "token",
			accountId: "account",
			bytes: recording.bytes,
			mimeType: "audio/webm",
		});
	});
	it("reports the service as unavailable outside the desktop shell", async () => {
		const deps = { ...setup(), direct: undefined };
		await expect(transcribeRecording(recording, deps)).rejects.toMatchObject({
			code: "service_unavailable",
		});
	});
	it("reports failed retries as transcription failures", async () => {
		const deps = setup();
		deps.direct.mockResolvedValue({ _tag: "failed" } as never);
		await expect(transcribeRecording(recording, deps)).rejects.toMatchObject({
			code: "transcription_failed",
		});
		deps.resolveAuth.mockRejectedValue(new Error("expired"));
		await expect(transcribeRecording(recording, deps)).rejects.toMatchObject({
			code: "transcription_failed",
		});
	});
});
