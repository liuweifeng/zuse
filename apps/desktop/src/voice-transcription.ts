import {
	MAX_VOICE_BYTES,
	uploadVoiceRecording,
} from "@zusehq/server/voice-upload";
import { ipcMain, net } from "electron";

export const VOICE_TRANSCRIBE_CHANNEL = "voice:transcribe";

export type VoiceTranscribeRequest = {
	readonly token: string;
	readonly accountId: string | null;
	readonly bytes: Uint8Array;
	readonly mimeType: string;
};

export type VoiceTranscribeResponse =
	| { readonly _tag: "transcribed"; readonly text: string }
	| { readonly _tag: "failed" };

const isBoundedString = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max;

export const parseVoiceTranscribeRequest = (
	raw: unknown,
): VoiceTranscribeRequest | null => {
	if (typeof raw !== "object" || raw === null) return null;
	const { token, accountId, bytes, mimeType } = raw as Record<string, unknown>;
	if (!isBoundedString(token, 16_384)) return null;
	if (accountId !== null && !isBoundedString(accountId, 256)) return null;
	if (
		!(bytes instanceof Uint8Array) ||
		bytes.byteLength === 0 ||
		bytes.byteLength > MAX_VOICE_BYTES
	)
		return null;
	if (!isBoundedString(mimeType, 128) || !mimeType.startsWith("audio/"))
		return null;
	return { token, accountId, bytes, mimeType };
};

/**
 * Uploads dictation from Chromium's network stack after the engine's Node
 * request was challenged by Cloudflare. The endpoint is fixed by the shared
 * upload module, so the renderer cannot aim this credentialed request
 * elsewhere. The token is used once and never logged.
 */
export const installVoiceTranscription = (): void => {
	ipcMain.handle(
		VOICE_TRANSCRIBE_CHANNEL,
		async (_event, raw: unknown): Promise<VoiceTranscribeResponse> => {
			const request = parseVoiceTranscribeRequest(raw);
			if (request === null) return { _tag: "failed" };
			try {
				const result = await uploadVoiceRecording({
					...request,
					fetch: (input, init) => net.fetch(input as string, init),
				});
				return result._tag === "transcribed" ? result : { _tag: "failed" };
			} catch {
				return { _tag: "failed" };
			}
		},
	);
};
