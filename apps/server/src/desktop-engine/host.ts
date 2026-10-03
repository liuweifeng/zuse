import { randomUUID } from "node:crypto";
import type { EngineChannel, EngineFrame } from "./channel.ts";

type Hello = Extract<EngineFrame, { _tag: "Hello" }>;
type Request = Extract<EngineFrame, { _tag: "HostRequest" }>;
type Notification = Extract<EngineFrame, { _tag: "HostEvent" }>;

/** Native requests belong to one desktop attachment; replacement cannot settle an old request. */
export class EngineHost {
	private owner: { channel: EngineChannel; hello: Hello } | null = null;
	private readonly pending = new Map<
		string,
		{ owner: EngineChannel; finish: (value: unknown, error?: Error) => void }
	>();
	private readonly callbacks = new Map<
		"account" | "linear",
		(url: string) => void
	>();
	constructor(private readonly timeoutMs = 30_000) {}
	get redirectUri(): string {
		return (
			this.owner?.hello.authRedirectUri ?? "http://localhost:8976/callback"
		);
	}
	get linearRedirectUri(): string {
		return (
			this.owner?.hello.linearRedirectUri ??
			"http://localhost:8976/linear/callback"
		);
	}
	attach(channel: EngineChannel, hello: Hello): boolean {
		if (!hello.host) return true;
		if (this.owner !== null) return false;
		this.owner = { channel, hello };
		void channel.closed.then(() => {
			if (this.owner?.channel === channel) this.owner = null;
			for (const entry of [...this.pending.values()])
				if (entry.owner === channel)
					entry.finish(undefined, new Error("The desktop disconnected."));
		});
		return true;
	}
	onCallback(flow: "account" | "linear", handler: (url: string) => void): void {
		this.callbacks.set(flow, handler);
	}
	receive(channel: EngineChannel, frame: EngineFrame): boolean {
		if (this.owner?.channel !== channel) return false;
		if (frame._tag === "HostCallback") {
			this.callbacks.get(frame.flow)?.(frame.url);
			return true;
		}
		if (frame._tag !== "HostResult") return false;
		const pending = this.pending.get(frame.id);
		if (pending?.owner !== channel) return true;
		pending.finish(
			frame.value,
			frame.error === undefined ? undefined : new Error(frame.error),
		);
		return true;
	}
	notify(name: Notification["name"], payload: unknown): void {
		this.owner?.channel.send({ _tag: "HostEvent", name, payload });
	}
	request(
		method: Request["method"],
		payload: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const owner = this.owner?.channel;
		if (owner === undefined)
			return Promise.reject(
				new Error("Open the desktop app to perform this action."),
			);
		if (signal?.aborted)
			return Promise.reject(new Error("The native request was cancelled."));
		if (this.pending.size >= 32)
			return Promise.reject(new Error("Too many pending native requests."));
		return new Promise((resolve, reject) => {
			const id = randomUUID();
			const finish = (value: unknown, error?: Error) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (error !== undefined) reject(error);
				else resolve(value);
			};
			const abort = () =>
				finish(undefined, new Error("The native request was cancelled."));
			const timer = setTimeout(
				() =>
					finish(undefined, new Error("The desktop did not respond in time.")),
				this.timeoutMs,
			);
			this.pending.set(id, { owner, finish });
			signal?.addEventListener("abort", abort, { once: true });
			if (!owner.send({ _tag: "HostRequest", id, method, payload }))
				finish(undefined, new Error("The desktop disconnected."));
		});
	}
}
