const VOICE_EXTENSIONS: Readonly<Record<string, string>> = {
	"audio/mp4": "m4a",
	"audio/m4a": "m4a",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/webm": "webm",
};

export const voiceRecordingFilename = (mimeType: string): string | null => {
	const normalized = mimeType.toLowerCase();
	if (!Object.hasOwn(VOICE_EXTENSIONS, normalized)) return null;
	const extension = VOICE_EXTENSIONS[normalized];
	return extension === undefined ? null : `recording.${extension}`;
};

export const MAX_VOICE_DURATION_MS = 150_000;
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

export const classifyVoiceFallback = (
	status: number,
	body: string,
): "unsupported" | "blocked" | "authentication-rejected" | null => {
	if (status === 401) return "authentication-rejected";
	if (
		status === 403 &&
		/(?:cloudflare|challenge|blocked|forbidden)/iu.test(body)
	)
		return "blocked";
	if (status === 403) return "authentication-rejected";
	if (status === 404 || status === 405 || status === 415) return "unsupported";
	return null;
};

export const voiceValidationReason = (
	bytes: Uint8Array,
	mimeType: string,
	durationMs: number,
): string | null => {
	if (bytes.byteLength === 0) return "Recording is empty.";
	if (bytes.byteLength > MAX_VOICE_BYTES)
		return "Recording exceeds the 10 MB limit.";
	if (durationMs <= 0 || durationMs > MAX_VOICE_DURATION_MS)
		return "Recording exceeds the 150 second limit.";
	if (voiceRecordingFilename(mimeType) === null)
		return "Recording format is not supported.";
	return null;
};
