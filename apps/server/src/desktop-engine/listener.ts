import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import {
	type EngineChannel,
	type EngineFrame,
	LOCAL_ENGINE_PROTOCOL,
	makeEngineChannel,
} from "./channel.ts";
import type { EngineHost } from "./host.ts";

export interface LocalEngineListener {
	readonly port: number;
	readonly close: () => Promise<void>;
}

export const listenLocalEngine = async (options: {
	readonly token: string;
	readonly host: EngineHost;
	readonly onRpc: (clientId: number, payload: string) => boolean;
	readonly onDisconnect: (clientId: number) => void;
	readonly clients: Map<number, EngineChannel>;
	readonly prepareShutdown?: () => Promise<boolean>;
	readonly shutdown?: () => void;
}): Promise<LocalEngineListener> => {
	let nextId = 0;
	const sockets = new Set<EngineChannel>();
	let shutdownRequested = false;
	const expected = Buffer.from(options.token);
	const server = createServer((socket) => {
		if (sockets.size >= 8) {
			socket.destroy();
			return;
		}
		const id = ++nextId;
		let authenticated = false;
		let preparingShutdown = false;
		const timeout = setTimeout(() => channel.close(), 5_000);
		const receive = (frame: EngineFrame) => {
			if (!authenticated) {
				if (frame._tag !== "Hello" || frame.version !== LOCAL_ENGINE_PROTOCOL) {
					channel.close();
					return;
				}
				const supplied = Buffer.from(frame.token);
				if (
					supplied.length !== expected.length ||
					!timingSafeEqual(supplied, expected) ||
					!options.host.attach(channel, frame)
				) {
					channel.close();
					return;
				}
				authenticated = true;
				clearTimeout(timeout);
				channel.authenticated();
				options.clients.set(id, channel);
				channel.send({ _tag: "Welcome", version: LOCAL_ENGINE_PROTOCOL });
				options.host.synchronize(channel);
				return;
			}
			if (frame._tag === "Ping") {
				channel.send({ _tag: "Pong" });
				return;
			}
			if (frame._tag === "Rpc") {
				if (!options.onRpc(id, frame.payload)) channel.close();
				return;
			}
			if (frame._tag === "ShutdownRequest") {
				if (preparingShutdown || frame.id.length > 128) {
					channel.close();
					return;
				}
				preparingShutdown = true;
				void Promise.resolve().then(async () => {
					try {
						const accepted =
							options.shutdown !== undefined &&
							(await options.prepareShutdown?.()) === true;
						channel.send({
							_tag: "ShutdownResult",
							id: frame.id,
							status: accepted ? "accepted" : "busy",
						});
						if (!accepted) return;
						let timer: ReturnType<typeof setTimeout> | undefined;
						const finish = () => {
							clearTimeout(timer);
							socket.off("finish", finish);
							if (shutdownRequested) return;
							shutdownRequested = true;
							options.shutdown?.();
						};
						// Flush the decision before scope shutdown destroys transports.
						timer = setTimeout(finish, 1_000);
						socket.once("finish", finish);
						if (socket.destroyed) finish();
						else socket.end();
					} catch {
						channel.send({
							_tag: "ShutdownResult",
							id: frame.id,
							status: "failed",
						});
					} finally {
						preparingShutdown = false;
					}
				});
				return;
			}
			if (!options.host.receive(channel, frame)) channel.close();
		};
		const channel = makeEngineChannel(socket, receive);
		sockets.add(channel);
		void channel.closed.then(() => {
			clearTimeout(timeout);
			sockets.delete(channel);
			options.clients.delete(id);
			if (authenticated) options.onDisconnect(id);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("Engine listener did not bind a loopback port.");
	return {
		port: address.port,
		close: () =>
			new Promise((resolve, reject) => {
				for (const socket of sockets) socket.close();
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				);
			}),
	};
};
