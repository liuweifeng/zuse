import { type Cause, Deferred, Effect, Layer, Queue, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import {
	RpcClientDefect,
	RpcClientError,
} from "effect/unstable/rpc/RpcClientError";
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

import type { RpcBridge } from "./bridge.ts";

type ElectronResponseWriter = (
	clientId: number,
	response: FromServerEncoded,
) => Effect.Effect<void>;

type ElectronResponseLane = Readonly<{
	queue: Queue.Queue<FromServerEncoded, Cause.Done>;
}>;

const requestResponseLaneKey = (
	clientId: number,
	requestId: string | number,
): string => JSON.stringify([clientId, "request", requestId]);

const responseLaneKey = (
	clientId: number,
	response: FromServerEncoded,
): string =>
	"requestId" in response
		? requestResponseLaneKey(clientId, response.requestId)
		: JSON.stringify([clientId, "broadcast"]);

/**
 * Preserve response order within one RPC without letting a backpressured stream
 * stall every other request on the connection. Effect RPC acknowledges a
 * stream chunk only after `writeResponse` admits it to that request's bounded
 * queue, so a server honoring `supportsAck` cannot grow an output lane without
 * bound while its consumer is behind.
 */
export const makeElectronResponseRouter = (
	writeResponse: ElectronResponseWriter,
) =>
	Effect.gen(function* () {
		const lanes = new Map<string, ElectronResponseLane>();

		const closeLane = (key: string, lane: ElectronResponseLane): void => {
			if (lanes.get(key) === lane) lanes.delete(key);
			Queue.endUnsafe(lane.queue);
		};

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				for (const [key, lane] of lanes) closeLane(key, lane);
			}),
		);

		return {
			route: (clientId: number, response: FromServerEncoded) =>
				Effect.gen(function* () {
					const key = responseLaneKey(clientId, response);
					let lane = lanes.get(key);
					if (lane === undefined) {
						lane = {
							queue: yield* Queue.make<FromServerEncoded, Cause.Done>(),
						};
						lanes.set(key, lane);
						const currentLane = lane;
						yield* Stream.fromQueue(currentLane.queue).pipe(
							Stream.runForEach((queued) =>
								writeResponse(clientId, queued).pipe(
									Effect.tap(() =>
										queued._tag === "Exit"
											? Effect.sync(() => closeLane(key, currentLane))
											: Effect.void,
									),
								),
							),
							Effect.ensuring(Effect.sync(() => closeLane(key, currentLane))),
							Effect.forkScoped,
						);
					}
					Queue.offerUnsafe(lane.queue, response);
				}),
			closeRequest: (clientId: number, requestId: string | number): void => {
				const key = requestResponseLaneKey(clientId, requestId);
				const lane = lanes.get(key);
				if (lane !== undefined) closeLane(key, lane);
			},
		};
	});

/**
 * RpcClient.Protocol implementation for Electron IPC. Mirror of the server
 * protocol — sends encoded request frames over the preload bridge, listens
 * for response frames coming back, hands each decoded response to
 * `writeResponse` so the framework can route it to the awaiting RPC.
 */
export const makeElectronClientProtocol = (
	bridge: RpcBridge,
	onClose: () => void = () => {},
) =>
	RpcClient.Protocol.make(
		Effect.fnUntraced(function* (writeResponse, clientIds) {
			const requestClientMap = new Map<string | number, number>();
			const connect = bridge.connect;
			const connectionId =
				connect === undefined ? undefined : crypto.randomUUID();
			let closed = false;
			const disconnected = yield* Deferred.make<void>();
			const disconnectError = new RpcClientError({
				reason: new RpcClientDefect({
					message: "The local engine disconnected.",
					cause: undefined,
				}),
			});
			const unsubscribeDisconnect = bridge.onDisconnect?.((id) => {
				if (id !== connectionId || closed) return;
				closed = true;
				Effect.runSync(Deferred.succeed(disconnected, undefined));
			});
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					unsubscribeDisconnect?.();
					if (connectionId !== undefined) bridge.disconnect?.(connectionId);
				}),
			);
			yield* Deferred.await(disconnected).pipe(
				Effect.andThen(() =>
					// A request may be sent before RpcClient installs its receive loop.
					// Include those clients so Protocol buffers their failure until run starts.
					Effect.forEach(
						new Set([...clientIds, ...requestClientMap.values()]),
						(clientId) =>
							writeResponse(clientId, {
								_tag: "ClientProtocolError",
								error: disconnectError,
							}),
					),
				),
				Effect.andThen(() => Effect.sync(onClose)),
				Effect.forkScoped,
			);
			if (connectionId !== undefined && connect !== undefined) {
				yield* Effect.tryPromise({
					try: () => connect(connectionId),
					catch: (cause) =>
						new RpcClientError({
							reason: new RpcClientDefect({
								message: "Could not attach to the local engine.",
								cause,
							}),
						}),
				});
				if (closed) return yield* Effect.fail(disconnectError);
			}
			const serialization = yield* RpcSerialization.RpcSerialization;
			const parser = serialization.makeUnsafe();
			const responseRouter = yield* makeElectronResponseRouter(writeResponse);

			const broadcast = (response: FromServerEncoded) =>
				Effect.forEach(clientIds, (clientId) =>
					responseRouter.route(clientId, response),
				);

			const inbound = yield* Queue.make<unknown, Cause.Done>();
			const unsubscribe = bridge.onMessage((frame) => {
				if (!closed) Queue.offerUnsafe(inbound, frame);
			}, connectionId);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					unsubscribe();
					Queue.endUnsafe(inbound);
				}),
			);

			yield* Stream.fromQueue(inbound).pipe(
				Stream.runForEach((frame) =>
					Effect.suspend(() => {
						const decoded = parser.decode(frame as Uint8Array | string);
						if (decoded.length === 0) return Effect.void;
						let i = 0;
						return Effect.whileLoop({
							while: () => i < decoded.length,
							body: () => {
								const response = decoded[i++] as FromServerEncoded;
								if ("requestId" in response) {
									const clientId = requestClientMap.get(response.requestId);
									if (clientId !== undefined) {
										if (response._tag === "Exit") {
											requestClientMap.delete(response.requestId);
										}
										return responseRouter.route(clientId, response);
									}
								}
								return broadcast(response);
							},
							step: () => undefined,
						});
					}),
				),
				Effect.forkScoped,
				Effect.interruptible,
			);

			return {
				send: (clientId, request) =>
					Effect.try({
						try: () => {
							if (closed) throw disconnectError;
							if (request._tag === "Request") {
								requestClientMap.set(request.id, clientId);
							} else if (request._tag === "Interrupt") {
								const requestClientId = requestClientMap.get(request.requestId);
								if (requestClientId !== undefined) {
									responseRouter.closeRequest(
										requestClientId,
										request.requestId,
									);
								}
								requestClientMap.delete(request.requestId);
							}
							const encoded = parser.encode(request);
							if (encoded === undefined) return;
							bridge.send(encoded, connectionId);
						},
						catch: (cause) =>
							new RpcClientError({
								reason: new RpcClientDefect({
									message: "Failed to send RPC frame over Electron IPC",
									cause,
								}),
							}),
					}),
				supportsAck: true,
				supportsTransferables: false,
			};
		}),
	);

export const electronClientProtocolLayer = (
	bridge: RpcBridge,
	onClose?: () => void,
) =>
	Layer.effect(RpcClient.Protocol, makeElectronClientProtocol(bridge, onClose));
