import type { AgentAvailability } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canDictate, VoiceDictation } from "../../src/lib/voice-dictation";

class Recorder {
	static isTypeSupported = () => true;
	static instances: Recorder[] = [];
	state = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor() {
		Recorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		queueMicrotask(() => {
			this.ondataavailable?.({ data: new Blob(["audio"]) });
			this.onstop?.();
		});
	}
}
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("voice dictation lifecycle", () => {
	const track = { stop: vi.fn(), onended: null as (() => void) | null };
	const stream = { getTracks: () => [track] };
	const getUserMedia = vi.fn();
	const create = () => {
		const callbacks = {
			capabilities: vi.fn(async () => ({
				available: true,
				maxDurationSeconds: 150,
				maxBytes: 1024,
			})),
			transcribe: vi.fn(
				async (_audio: {
					bytes: Uint8Array;
					mimeType: string;
					durationMs: number;
				}) => "spoken words",
			),
			onState: vi.fn(),
			onTranscript: vi.fn(),
			onError: vi.fn(),
		};
		return { controller: new VoiceDictation(callbacks), ...callbacks };
	};
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		Recorder.instances = [];
		track.onended = null;
		getUserMedia.mockResolvedValue(stream);
		vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
		vi.stubGlobal("MediaRecorder", Recorder);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it("releases the microphone before transcription and delivers text once", async () => {
		const voice = create();
		await voice.controller.start();
		voice.controller.stop();
		voice.controller.stop();
		expect(track.stop).toHaveBeenCalled();
		await flush();
		expect(voice.transcribe).toHaveBeenCalledTimes(1);
		expect(voice.transcribe.mock.calls[0]?.[0]).toMatchObject({
			mimeType: "audio/webm",
		});
		expect(voice.onTranscript).toHaveBeenCalledExactlyOnceWith("spoken words");
		voice.controller.cancel();
	});
	it("releases a stream granted after cancellation without recording", async () => {
		const permission = deferred<typeof stream>();
		getUserMedia.mockReturnValue(permission.promise);
		const voice = create();
		const start = voice.controller.start();
		await flush();
		voice.controller.cancel();
		permission.resolve(stream);
		await start;
		expect(track.stop).toHaveBeenCalled();
		expect(Recorder.instances).toHaveLength(0);
	});
	it("ignores a transcription delivered after cancel or session teardown", async () => {
		const response = deferred<string>();
		const voice = create();
		voice.transcribe.mockReturnValue(response.promise);
		await voice.controller.start();
		voice.controller.stop();
		await flush();
		voice.controller.cancel();
		response.resolve("stale transcript");
		await flush();
		expect(voice.onTranscript).not.toHaveBeenCalled();
	});
	it("stops at the server duration limit", async () => {
		const voice = create();
		await voice.controller.start();
		await vi.advanceTimersByTimeAsync(150_000);
		expect(voice.transcribe).toHaveBeenCalledTimes(1);
		expect(track.stop).toHaveBeenCalled();
	});
	it("cancels oversized recordings without sending audio", async () => {
		const voice = create();
		await voice.controller.start();
		Recorder.instances[0]?.ondataavailable?.({
			data: new Blob([new Uint8Array(1025)]),
		});
		await flush();
		expect(voice.onError).toHaveBeenCalledWith("too_large");
		expect(voice.transcribe).not.toHaveBeenCalled();
		expect(track.stop).toHaveBeenCalled();
	});
	it("does not request the microphone without a compatible account", async () => {
		const voice = create();
		voice.capabilities.mockResolvedValue({
			available: false,
			maxDurationSeconds: 150,
			maxBytes: 1024,
		});
		await voice.controller.start();
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(voice.onError).toHaveBeenCalledWith("account_required");
	});
	it("handles denied permission and allows retry", async () => {
		const voice = create();
		getUserMedia.mockRejectedValueOnce(
			new DOMException("Denied", "NotAllowedError"),
		);
		await voice.controller.start();
		expect(voice.onError).toHaveBeenCalledWith("permission_denied");
		await voice.controller.start();
		expect(Recorder.instances).toHaveLength(1);
		voice.controller.cancel();
	});
	it("reports a missing microphone distinctly from denied access", async () => {
		const voice = create();
		getUserMedia.mockRejectedValueOnce(
			new DOMException("No device", "NotFoundError"),
		);
		await voice.controller.start();
		expect(voice.onError).toHaveBeenCalledWith("no_microphone");
	});
	it("meters elapsed and remaining time only while recording", async () => {
		const voice = create();
		expect(voice.controller.meter()).toBeNull();
		await voice.controller.start();
		await vi.advanceTimersByTimeAsync(4_000);
		const meter = voice.controller.meter();
		expect(meter?.elapsedMs).toBeGreaterThanOrEqual(4_000);
		expect(meter?.remainingMs).toBeLessThanOrEqual(146_000);
		expect(meter?.level).toBe(0);
		voice.controller.stop();
		expect(voice.controller.meter()).toBeNull();
		voice.controller.cancel();
	});
	it("reports recorder failure and releases hardware", async () => {
		const voice = create();
		await voice.controller.start();
		Recorder.instances[0]?.onerror?.();
		expect(track.stop).toHaveBeenCalled();
		expect(voice.onError).toHaveBeenCalledWith("recorder_failed");
		expect(voice.transcribe).not.toHaveBeenCalled();
	});
	it("reports empty transcripts and permits another recording", async () => {
		const voice = create();
		voice.transcribe.mockResolvedValueOnce("   ");
		await voice.controller.start();
		voice.controller.stop();
		await flush();
		expect(voice.onTranscript).not.toHaveBeenCalled();
		expect(voice.onError).toHaveBeenCalledWith("no_speech");
		await voice.controller.start();
		voice.controller.stop();
		await flush();
		expect(voice.onTranscript).toHaveBeenCalledExactlyOnceWith("spoken words");
	});
	it("ignores failure from cancelled transcription during a new recording", async () => {
		let reject!: (error: Error) => void;
		const response = new Promise<string>((_, fail) => {
			reject = fail;
		});
		const voice = create();
		voice.transcribe.mockReturnValueOnce(response);
		await voice.controller.start();
		voice.controller.stop();
		await flush();
		voice.controller.cancel();
		await voice.controller.start();
		reject(new Error("Old request failed"));
		await flush();
		expect(voice.onError).not.toHaveBeenCalled();
		expect(voice.onState).toHaveBeenLastCalledWith("recording");
		voice.controller.cancel();
	});
});

describe("dictation availability", () => {
	const codex = (fields: Record<string, unknown>) =>
		({
			providerId: "codex",
			displayName: "Codex",
			cliInstalled: true,
			cliLoggedIn: true,
			hasApiKey: false,
			...fields,
		}) as AgentAvailability;
	it("is offered only for a verified ChatGPT account on Codex", () => {
		expect(
			canDictate([codex({ authStatus: "authenticated", authType: "chatgpt" })]),
		).toBe(true);
		expect(
			canDictate([codex({ authStatus: "authenticated", authType: "apiKey" })]),
		).toBe(false);
		expect(
			canDictate([codex({ authStatus: "unknown", authType: "chatgpt" })]),
		).toBe(false);
		expect(
			canDictate([
				codex({
					authStatus: "authenticated",
					authType: "chatgpt",
					status: "disabled",
				}),
			]),
		).toBe(false);
	});
	it("is hidden before provider discovery or without Codex", () => {
		expect(canDictate(undefined)).toBe(false);
		expect(
			canDictate([
				{
					...codex({ authStatus: "authenticated", authType: "chatgpt" }),
					providerId: "claude",
				},
			]),
		).toBe(false);
	});
});
