import type { AgentAvailability } from "@zuse/contracts";

export type DictationState = "idle" | "starting" | "recording" | "transcribing";
export type DictationErrorCode =
	| "unsupported"
	| "account_required"
	| "format_unsupported"
	| "permission_denied"
	| "no_microphone"
	| "too_large"
	| "recorder_failed"
	| "no_audio"
	| "no_speech"
	| "transcription_failed"
	| "service_unavailable"
	| "start_failed";

/** A failure the UI can describe; any other thrown value maps to a generic code. */
export class DictationError extends Error {
	constructor(readonly code: DictationErrorCode) {
		super(code);
	}
}

/**
 * Transcription runs through the ChatGPT account Codex is signed in with, so
 * dictation exists only where that account is verified. Unknown auth counts as
 * unavailable: a control that cannot work should not be offered.
 */
export const canDictate = (
	availability: ReadonlyArray<AgentAvailability> | undefined,
): boolean =>
	availability?.some(
		(provider) =>
			provider.providerId === "codex" &&
			provider.status !== "disabled" &&
			provider.authStatus === "authenticated" &&
			provider.authType === "chatgpt",
	) ?? false;

export interface DictationMeter {
	/** Input loudness from 0 (silence) to 1. */
	level: number;
	elapsedMs: number;
	remainingMs: number;
}
export interface VoiceLimits {
	available: boolean;
	maxDurationSeconds: number;
	maxBytes: number;
}

/** Owns microphone lifetime; cancelled work can never deliver a late transcript. */
export class VoiceDictation {
	private generation = 0;
	private state: DictationState = "idle";
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private startedAt = 0;
	private limitMs = 0;
	private analyser: {
		context: AudioContext;
		node: AnalyserNode;
		samples: Uint8Array<ArrayBuffer>;
	} | null = null;

	constructor(
		private readonly options: {
			capabilities: () => Promise<VoiceLimits>;
			transcribe: (audio: {
				bytes: Uint8Array;
				mimeType: string;
				durationMs: number;
			}) => Promise<string>;
			onState: (state: DictationState) => void;
			onTranscript: (text: string) => void;
			onError: (code: DictationErrorCode) => void;
		},
	) {}

	private setState(state: DictationState) {
		this.state = state;
		this.options.onState(state);
	}

	/** Live input level and time budget while recording; null otherwise. */
	meter(): DictationMeter | null {
		if (this.state !== "recording") return null;
		const elapsedMs = Math.max(0, performance.now() - this.startedAt);
		let level = 0;
		if (this.analyser !== null) {
			const { node, samples } = this.analyser;
			node.getByteTimeDomainData(samples);
			let sum = 0;
			for (const sample of samples) {
				const centered = (sample - 128) / 128;
				sum += centered * centered;
			}
			// Speech RMS rarely exceeds ~0.3; scale so normal speaking fills the meter.
			level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
		}
		return {
			level,
			elapsedMs,
			remainingMs: Math.max(0, this.limitMs - elapsedMs),
		};
	}

	private releaseInput() {
		const analyser = this.analyser;
		this.analyser = null;
		void analyser?.context.close().catch(() => undefined);
		this.stream?.getTracks().forEach((track) => {
			track.onended = null;
			track.stop();
		});
	}

	private release() {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		const recorder = this.recorder;
		this.recorder = null;
		if (recorder !== null) {
			recorder.onstop = null;
			recorder.ondataavailable = null;
			recorder.onerror = null;
			if (recorder.state !== "inactive") recorder.stop();
		}
		this.releaseInput();
		this.stream = null;
	}

	cancel() {
		this.generation++;
		this.release();
		this.setState("idle");
	}

	stop() {
		if (this.state !== "recording") return;
		this.setState("transcribing");
		if (this.recorder?.state === "recording") this.recorder.stop();
		// Release the hardware immediately, before waiting for transcription.
		this.releaseInput();
	}

	private attachAnalyser(stream: MediaStream) {
		// Metering is cosmetic; recording must not depend on Web Audio.
		if (typeof AudioContext === "undefined") return;
		try {
			const context = new AudioContext();
			const node = context.createAnalyser();
			node.fftSize = 512;
			context.createMediaStreamSource(stream).connect(node);
			this.analyser = {
				context,
				node,
				samples: new Uint8Array(node.fftSize),
			};
		} catch {
			this.analyser = null;
		}
	}

	async start() {
		if (this.state !== "idle") return;
		const generation = ++this.generation;
		const current = () => generation === this.generation;
		const fail = (code: DictationErrorCode) => {
			if (!current()) return;
			this.cancel();
			this.options.onError(code);
		};
		this.setState("starting");
		try {
			if (
				!globalThis.navigator?.mediaDevices?.getUserMedia ||
				typeof MediaRecorder === "undefined"
			) {
				throw new DictationError("unsupported");
			}
			const limits = await this.options.capabilities();
			if (!current()) return;
			if (!limits.available) throw new DictationError("account_required");
			const mimeType = [
				"audio/webm;codecs=opus",
				"audio/webm",
				"audio/mp4",
			].find((type) => MediaRecorder.isTypeSupported(type));
			if (!mimeType) throw new DictationError("format_unsupported");
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (!current()) {
				stream.getTracks().forEach((track) => {
					track.stop();
				});
				return;
			}
			this.stream = stream;
			const recorder = new MediaRecorder(stream, {
				mimeType,
				audioBitsPerSecond: 64_000,
			});
			this.recorder = recorder;
			const chunks: Blob[] = [];
			let size = 0;
			recorder.ondataavailable = ({ data }) => {
				if (!current() || data.size === 0) return;
				size += data.size;
				if (size > limits.maxBytes) {
					fail("too_large");
					return;
				}
				chunks.push(data);
			};
			recorder.onerror = () => fail("recorder_failed");
			recorder.onstop = () => {
				if (!current()) return;
				const durationMs = Math.max(
					1,
					Math.min(performance.now() - this.startedAt, this.limitMs),
				);
				this.release();
				this.setState("transcribing");
				void (async () => {
					try {
						const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
						if (blob.size === 0) throw new DictationError("no_audio");
						const bytes = new Uint8Array(await blob.arrayBuffer());
						if (!current()) return;
						const text = await this.options.transcribe({
							bytes,
							mimeType: blob.type,
							durationMs,
						});
						if (!current()) return;
						if (!text.trim()) throw new DictationError("no_speech");
						this.setState("idle");
						this.options.onTranscript(text.trim());
					} catch (error) {
						fail(
							error instanceof DictationError
								? error.code
								: "transcription_failed",
						);
					}
				})();
			};
			stream.getTracks().forEach((track) => {
				track.onended = () => this.stop();
			});
			this.attachAnalyser(stream);
			recorder.start(250);
			this.startedAt = performance.now();
			this.limitMs = limits.maxDurationSeconds * 1000;
			this.setState("recording");
			this.timer = setTimeout(() => this.stop(), this.limitMs);
		} catch (error) {
			fail(startErrorCode(error));
		}
	}
}

const startErrorCode = (error: unknown): DictationErrorCode => {
	if (error instanceof DictationError) return error.code;
	if (error instanceof DOMException) {
		if (error.name === "NotAllowedError" || error.name === "SecurityError")
			return "permission_denied";
		if (error.name === "NotFoundError" || error.name === "NotReadableError")
			return "no_microphone";
	}
	return "start_failed";
};
