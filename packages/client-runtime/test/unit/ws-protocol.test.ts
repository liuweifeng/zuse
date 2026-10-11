import { Effect } from "effect";
import { RpcSerialization } from "effect/unstable/rpc";
import { describe, expect, it, vi } from "vitest";
import {
	authenticatedWsUrl,
	observeWebSocketConstructor,
	responseSerializationLayer,
} from "../../src/ws-protocol.ts";

describe("WebSocket client protocol", () => {
	it("builds one authenticated wire-versioned endpoint for every client", () => {
		expect(
			authenticatedWsUrl({
				host: " 127.0.0.1 ",
				port: 8787,
				token: " token-value ",
			}),
		).toBe("ws://127.0.0.1:8787/?token=token-value&wireVersion=7");
	});

	it("prefers a managed base URL", () => {
		expect(
			authenticatedWsUrl({
				host: "ignored",
				port: 1,
				wsBaseUrl: "wss://environment.example/rpc",
			}),
		).toBe("wss://environment.example/rpc?wireVersion=7");
	});

	it("reports an established socket closing to the connection owner", () => {
		const socket = new EventTarget();
		const onClose = vi.fn();
		const make = observeWebSocketConstructor(
			() => socket as unknown as WebSocket,
			onClose,
		);

		expect(make("wss://environment.example/rpc")).toBe(socket);
		socket.dispatchEvent(new CloseEvent("close", { code: 1006 }));

		expect(onClose).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledWith(
			expect.objectContaining({ code: 1006 }),
		);
	});
});

it("adapts only incoming responses after the negotiated version changes", async () => {
	let version = 7;
	const parser = await Effect.runPromise(
		RpcSerialization.RpcSerialization.pipe(
			Effect.map((serialization) => serialization.makeUnsafe()),
			Effect.provide(
				responseSerializationLayer((value) =>
					version < 7 ? { adapted: value } : value,
				),
			),
		),
	);
	const response = { _tag: "Exit", requestId: "1" };
	expect(parser.decode(JSON.stringify(response))).toEqual([response]);
	version = 6;
	expect(parser.decode(JSON.stringify(response))).toEqual([
		{ adapted: response },
	]);
	expect(parser.encode(response)).toBe(JSON.stringify(response));
});
