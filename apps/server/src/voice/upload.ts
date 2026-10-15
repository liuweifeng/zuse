import {
	classifyVoiceFallback,
	MAX_VOICE_BYTES,
	voiceRecordingFilename,
} from "./policy.ts";

/**
 * The one transcription request shape. It is dependency-free so the desktop
 * shell can send it through Chromium's network stack: Cloudflare challenges
 * Node and curl clients on this endpoint but admits Chromium.
 */
export const VOICE_TRANSCRIPTION_ENDPOINT =
	"https://chatgpt.com/backend-api/transcribe";
export { MAX_VOICE_BYTES };

export type VoiceUploadResult =
	| { readonly _tag: "transcribed"; readonly text: string }
	| {
			readonly _tag: "fallback";
			readonly reason: "unsupported" | "blocked" | "authentication-rejected";
	  };

const transcriptFromBody = (body: string): string | null => {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return null;
		for (const key of ["text", "transcript"] as const) {
			const value = (parsed as Record<string, unknown>)[key];
			if (typeof value === "string") return value;
		}
		return null;
	} catch {
		return null;
	}
};

export const uploadVoiceRecording = async (input: {
	readonly token: string;
	readonly accountId: string | null;
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly fetch: typeof globalThis.fetch;
}): Promise<VoiceUploadResult> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const form = new FormData();
		form.append(
			"file",
			new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
			voiceRecordingFilename(input.mimeType) ?? "recording.audio",
		);
		const response = await input.fetch(VOICE_TRANSCRIPTION_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${input.token}`,
				...(input.accountId === null
					? {}
					: { "ChatGPT-Account-Id": input.accountId }),
				"User-Agent": "Zuse-Mobile-Voice/1",
			},
			body: form,
			signal: controller.signal,
		});
		const body = await response.text();
		if (!response.ok) {
			const fallback = classifyVoiceFallback(response.status, body);
			if (fallback !== null) return { _tag: "fallback", reason: fallback };
			throw new Error(`transcription provider returned ${response.status}`);
		}
		// Silence is a valid response with empty text; callers report it as
		// "no speech" rather than a failed request.
		const text = transcriptFromBody(body);
		if (text === null)
			throw new Error("transcription provider returned no transcript");
		return { _tag: "transcribed", text: text.trim() };
	} finally {
		clearTimeout(timer);
	}
};
