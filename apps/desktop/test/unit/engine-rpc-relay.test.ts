import type {
	DesktopEngineEndpoint,
	EngineChannel,
	EngineFrame,
} from "@zusehq/server/desktop-engine";
import { expect, it } from "vitest";
import { makeEngineRpcRelay } from "../../src/ipc/engine-rpc-relay.ts";

const endpoint: DesktopEngineEndpoint = {
	version: 1,
	token: "t".repeat(64),
	port: 1,
	apiPort: 2,
	pid: 3,
	appVersion: "test",
};
const fixture = () => {
	const connections: Array<{
		channel: EngineChannel;
		receive: (frame: Extract<EngineFrame, { _tag: "Rpc" }>) => void;
		sent: EngineFrame[];
		isClosed: () => boolean;
	}> = [];
	const messages: Array<[string, string]> = [];
	const disconnected: string[] = [];
	const relay = makeEngineRpcRelay({
		endpoint: async () => endpoint,
		message: (id, payload) => {
			messages.push([id, payload]);
		},
		disconnected: (id) => {
			disconnected.push(id);
		},
		connect: async (_, options) => {
			let closed = false,
				finish = () => {};
			const sent: EngineFrame[] = [];
			const channel: EngineChannel = {
				closed: new Promise<void>((resolve) => {
					finish = resolve;
				}),
				close: () => {
					closed = true;
					finish();
				},
				authenticated: () => {},
				send: (frame) => {
					if (closed) return false;
					sent.push(frame);
					return true;
				},
			};
			connections.push({
				channel,
				receive: options.receive,
				sent,
				isClosed: () => closed,
			});
			return channel;
		},
	});
	return { relay, connections, messages, disconnected };
};

it("isolates response and cancellation frames across renderer reloads", async () => {
	const f = fixture();
	await f.relay.open("first");
	f.relay.send("first", "request 0");
	await f.relay.open("second");
	expect(f.connections[0]?.isClosed()).toBe(true);
	f.relay.send("first", "stale interrupt 0");
	f.relay.close("first");
	f.connections[0]?.receive({ _tag: "Rpc", payload: "stale response 0" });
	f.relay.send("second", "request 0");
	f.connections[1]?.receive({ _tag: "Rpc", payload: "response 0" });
	expect(f.connections[1]?.sent).toEqual([
		{ _tag: "Rpc", payload: "request 0" },
	]);
	expect(f.messages).toEqual([["second", "response 0"]]);
	expect(f.disconnected).toEqual(["first"]);
	f.relay.dispose();
	expect(f.connections[1]?.isClosed()).toBe(true);
	await expect(f.relay.open("third")).rejects.toThrow("closed");
});

it("reports a channel loss once and never replays requests on replacement", async () => {
	const f = fixture();
	await f.relay.open("first");
	f.relay.send("first", "mutation");
	f.connections[0]?.channel.close();
	await Promise.resolve();
	f.relay.send("first", "late mutation");
	await f.relay.open("second");
	expect(f.disconnected).toEqual(["first"]);
	expect(f.connections[1]?.sent).toEqual([]);
	f.relay.dispose();
});

it("cancels pending endpoint discovery when a renderer disappears", async () => {
	let finish: (value: DesktopEngineEndpoint) => void = () => {};
	let signal: AbortSignal | undefined;
	let connectCount = 0;
	const relay = makeEngineRpcRelay({
		endpoint: (value) => {
			signal = value;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
		message: () => {},
		disconnected: () => {},
		connect: async () => {
			connectCount++;
			throw new Error("should not connect");
		},
	});
	const pending = relay.open("first");
	relay.dispose();
	finish(endpoint);
	await expect(pending).rejects.toThrow();
	expect(signal?.aborted).toBe(true);
	expect(connectCount).toBe(0);
});

it("closes a connection that finishes opening after its renderer was replaced", async () => {
	let finish: (value: EngineChannel) => void = () => {};
	let begun = () => {};
	const connecting = new Promise<void>((resolve) => {
		begun = resolve;
	});
	let closed = false;
	const relay = makeEngineRpcRelay({
		endpoint: async () => endpoint,
		message: () => {},
		disconnected: () => {},
		connect: () => {
			begun();
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	const pending = relay.open("first");
	await connecting;
	relay.reset();
	finish({
		closed: Promise.resolve(),
		close: () => {
			closed = true;
		},
		authenticated: () => {},
		send: () => true,
	});
	await expect(pending).rejects.toThrow("replaced");
	expect(closed).toBe(true);
});
