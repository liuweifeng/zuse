import type { VoiceTranscriptionResult } from "@zuse/contracts";
import type { AppBridge } from "./bridge.ts";
import { DictationError } from "./voice-dictation.ts";

type Recording = {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly durationMs: number;
};

/**
 * The engine transcribes first. When the provider turns its request away
 * (Cloudflare challenges Node clients), it issues a single-use ticket and the
 * desktop shell retries through Chromium, the same recovery mobile performs
 * from the phone.
 */
export const transcribeRecording = async (
	recording: Recording,
	dependencies: {
		readonly transcribe: (
			recording: Recording,
		) => Promise<VoiceTranscriptionResult>;
		readonly resolveAuth: (ticket: string) => Promise<{
			readonly token: string;
			readonly accountId: string | null;
		}>;
		readonly direct: AppBridge["transcribeVoice"];
	},
): Promise<string> => {
	const result = await dependencies.transcribe(recording).catch(() => {
		throw new DictationError("transcription_failed");
	});
	if (result._tag === "transcribed") return result.text;
	const direct = dependencies.direct;
	if (direct === undefined) throw new DictationError("service_unavailable");
	const auth = await dependencies.resolveAuth(result.ticket).catch(() => {
		throw new DictationError("transcription_failed");
	});
	const retried = await direct({
		token: auth.token,
		accountId: auth.accountId,
		bytes: recording.bytes,
		mimeType: recording.mimeType,
	}).catch(() => ({ _tag: "failed" }) as const);
	if (retried._tag !== "transcribed")
		throw new DictationError("transcription_failed");
	return retried.text;
};
