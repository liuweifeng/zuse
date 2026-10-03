import type {
	DesktopEngineEndpoint,
	EngineChannel,
	EngineFrame,
} from "@zusehq/server/desktop-engine";
import { expect, it } from "vitest";
import { makeEngineRpcConnection } from "../../src/ipc/engine-rpc-connection.ts";

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
	const connection = makeEngineRpcConnection({
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
	return { connection, connections, messages, disconnected };
};

it("isolates response and cancellation frames across renderer reloads", async () => {
	const f = fixture();
	await f.connection.open("first");
	f.connection.send("first", "request 0");
	await f.connection.open("second");
	expect(f.connections[0]?.isClosed()).toBe(true);
	f.connection.send("first", "stale interrupt 0");
	f.connection.close("first");
	f.connections[0]?.receive({ _tag: "Rpc", payload: "stale response 0" });
	f.connection.send("second", "request 0");
	f.connections[1]?.receive({ _tag: "Rpc", payload: "response 0" });
	expect(f.connections[1]?.sent).toEqual([
		{ _tag: "Rpc", payload: "request 0" },
	]);
	expect(f.messages).toEqual([["second", "response 0"]]);
	expect(f.disconnected).toEqual(["first"]);
	f.connection.dispose();
	expect(f.connections[1]?.isClosed()).toBe(true);
	await expect(f.connection.open("third")).rejects.toThrow("closed");
});

it("reports a channel loss once and never replays requests on replacement", async () => {
	const f = fixture();
	await f.connection.open("first");
	f.connection.send("first", "mutation");
	f.connections[0]?.channel.close();
	await Promise.resolve();
	f.connection.send("first", "late mutation");
	await f.connection.open("second");
	expect(f.disconnected).toEqual(["first"]);
	expect(f.connections[1]?.sent).toEqual([]);
	f.connection.dispose();
});

it("cancels pending endpoint discovery when a renderer disappears", async () => {
	let finish: (value: DesktopEngineEndpoint) => void = () => {};
	let signal: AbortSignal | undefined;
	let connectCount = 0;
	const connection = makeEngineRpcConnection({
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
	const pending = connection.open("first");
	connection.dispose();
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
	const connection = makeEngineRpcConnection({
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
	const pending = connection.open("first");
	await connecting;
	connection.reset();
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
