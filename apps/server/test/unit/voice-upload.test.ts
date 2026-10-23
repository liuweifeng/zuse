import { describe, expect, it, vi } from "vitest";

import {
	uploadVoiceRecording,
	VOICE_TRANSCRIPTION_ENDPOINT,
} from "../../src/voice/upload.ts";

const respond = (status: number, body: string) =>
	vi.fn(async () => new Response(body, { status }));
const upload = (fetch: typeof globalThis.fetch) =>
	uploadVoiceRecording({
		token: "token",
		accountId: "account",
		bytes: new Uint8Array([1, 2, 3]),
		mimeType: "audio/webm",
		fetch,
	});

describe("voice upload", () => {
	it("sends the recording to the fixed endpoint with account headers", async () => {
		const fetch = respond(200, JSON.stringify({ text: " hello " }));
		await expect(upload(fetch)).resolves.toEqual({
			_tag: "transcribed",
			text: "hello",
		});
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(VOICE_TRANSCRIPTION_ENDPOINT);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer token",
			"ChatGPT-Account-Id": "account",
		});
		const file = (init.body as FormData).get("file") as File;
		expect(file.name).toBe("recording.webm");
	});
	it("reports a Cloudflare challenge as blocked so another client can retry", async () => {
		await expect(
			upload(respond(403, "<html>cloudflare challenge</html>")),
		).resolves.toEqual({ _tag: "fallback", reason: "blocked" });
	});
	it("returns silence as an empty transcript instead of failing", async () => {
		await expect(
			upload(respond(200, JSON.stringify({ text: "", asset_format: "wav" }))),
		).resolves.toEqual({ _tag: "transcribed", text: "" });
	});
	it("fails on responses without a transcript or unexpected errors", async () => {
		await expect(upload(respond(200, "not json"))).rejects.toThrow();
		await expect(upload(respond(500, "oops"))).rejects.toThrow("500");
	});
});
