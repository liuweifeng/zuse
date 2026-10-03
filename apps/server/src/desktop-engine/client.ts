import { connect } from "node:net";
import {
	type EngineChannel,
	type EngineFrame,
	LOCAL_ENGINE_PROTOCOL,
	makeEngineChannel,
} from "./channel.ts";

export interface EngineEndpoint {
	readonly version: number;
	readonly port: number;
	readonly token: string;
}

/** Connect once. The caller repairs projections after disconnect; requests are never replayed here. */
export const connectLocalEngine = (
	endpoint: EngineEndpoint,
	options: {
		readonly host?: {
			readonly authRedirectUri: string;
		};
		readonly receive: (
			frame: Exclude<
				EngineFrame,
				{ _tag: "Hello" | "Welcome" | "Ping" | "Pong" }
			>,
		) => void;
		readonly signal?: AbortSignal;
	},
): Promise<EngineChannel> =>
	new Promise((resolve, reject) => {
		if (
			endpoint.version !== LOCAL_ENGINE_PROTOCOL ||
			!Number.isInteger(endpoint.port) ||
			endpoint.port < 1 ||
			endpoint.port > 65535
		) {
			reject(new Error("Incompatible local engine endpoint."));
			return;
		}
		if (options.signal?.aborted) {
			reject(new Error("Engine connection cancelled."));
			return;
		}
		const socket = connect({ host: "127.0.0.1", port: endpoint.port });
		let ready = false;
		let lastPong = performance.now();
		const channel = makeEngineChannel(socket, (frame) => {
			if (!ready) {
				if (
					frame._tag !== "Welcome" ||
					frame.version !== LOCAL_ENGINE_PROTOCOL
				) {
					channel.close();
					return;
				}
				ready = true;
				channel.authenticated();
				clearTimeout(timeout);
				resolve(channel);
				return;
			}
			if (frame._tag === "Pong") {
				lastPong = performance.now();
				return;
			}
			if (
				frame._tag === "Hello" ||
				frame._tag === "Welcome" ||
				frame._tag === "Ping"
			) {
				channel.close();
				return;
			}
			options.receive(frame);
		});
		const abort = () => channel.close();
		options.signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(() => channel.close(), 5_000);
		const heartbeat = setInterval(() => {
			if (!ready) return;
			if (performance.now() - lastPong > 15_000) channel.close();
			else channel.send({ _tag: "Ping" });
		}, 5_000);
		heartbeat.unref();
		socket.once("connect", () =>
			channel.send({
				_tag: "Hello",
				version: LOCAL_ENGINE_PROTOCOL,
				token: endpoint.token,
				host: options.host !== undefined,
				...options.host,
			}),
		);
		void channel.closed.then(() => {
			clearTimeout(timeout);
			clearInterval(heartbeat);
			options.signal?.removeEventListener("abort", abort);
			if (!ready)
				reject(
					new Error(
						"The local engine could not be reached or rejected the attachment.",
					),
				);
		});
	});
