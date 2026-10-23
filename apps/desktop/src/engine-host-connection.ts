import { setTimeout as delay } from "node:timers/promises";
import {
	connectLocalEngine,
	type DesktopEngineEndpoint,
	type EngineChannel,
	type EngineFrame,
} from "@zusehq/server/desktop-engine";

type HostRequest = Extract<EngineFrame, { _tag: "HostRequest" }>;
type HostEvent = Extract<EngineFrame, { _tag: "HostEvent" }>;

/** Native actions belong to an attachment, independent of renderer reloads. */
export const connectEngineHost = (options: {
	readonly endpoint: (signal: AbortSignal) => Promise<DesktopEngineEndpoint>;
	readonly authRedirectUri: () => string;
	readonly request: (
		request: HostRequest,
		signal: AbortSignal,
	) => Promise<unknown>;
	readonly event: (event: HostEvent) => void;
	readonly state?: (state: Extract<EngineFrame, { _tag: "HostState" }>) => void;
	readonly attached?: () => void;
	readonly connect?: typeof connectLocalEngine;
	readonly retryMs?: number;
}) => {
	const lifetime = new AbortController();
	let current: EngineChannel | null = null;
	const done = (async () => {
		while (!lifetime.signal.aborted) {
			const attachment = new AbortController();
			const requests = new Map<string, AbortController>();
			const abort = () => attachment.abort();
			lifetime.signal.addEventListener("abort", abort, { once: true });
			let channel: EngineChannel | null = null;
			try {
				const endpoint = await options.endpoint(attachment.signal);
				attachment.signal.throwIfAborted();
				channel = await (options.connect ?? connectLocalEngine)(endpoint, {
					host: { authRedirectUri: options.authRedirectUri() },
					signal: attachment.signal,
					receive: (frame) => {
						if (attachment.signal.aborted) return;
						if (frame._tag === "HostState") {
							options.state?.(frame);
							return;
						}
						if (frame._tag === "HostCancel") {
							requests.get(frame.id)?.abort();
							return;
						}
						if (frame._tag === "HostEvent") {
							options.event(frame);
							return;
						}
						if (frame._tag !== "HostRequest") return;
						if (requests.has(frame.id) || requests.size >= 32) {
							attachment.abort();
							channel?.close();
							return;
						}
						const request = new AbortController();
						requests.set(frame.id, request);

						void Promise.resolve().then(async () => {
							if (attachment.signal.aborted || request.signal.aborted) {
								requests.delete(frame.id);
								return;
							}
							let value: unknown = null;
							let error: string | undefined;
							try {
								value = await options.request(frame, request.signal);
							} catch {
								error = "The desktop could not complete this action.";
							}
							requests.delete(frame.id);
							if (!attachment.signal.aborted && !request.signal.aborted)
								channel?.send({
									_tag: "HostResult",
									id: frame.id,
									value,
									error,
								});
						});
					},
				});
				attachment.signal.throwIfAborted();
				current = channel;
				options.attached?.();
				await channel.closed;
			} catch {
			} finally {
				attachment.abort();
				for (const request of requests.values()) request.abort();
				requests.clear();
				channel?.close();
				if (current === channel) current = null;
				lifetime.signal.removeEventListener("abort", abort);
			}
			if (!lifetime.signal.aborted)
				await delay(options.retryMs ?? 500, undefined, {
					signal: lifetime.signal,
				}).catch(() => {});
		}
	})();
	return {
		callback: (url: string): boolean =>
			current?.send({ _tag: "HostCallback", flow: "account", url }) ?? false,
		close: (): Promise<void> => {
			lifetime.abort();
			current?.close();
			return done;
		},
	};
};
