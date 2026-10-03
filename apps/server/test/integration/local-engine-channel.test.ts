import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { ComputerAwakeStatus } from "@zuse/contracts";
import { afterEach, expect, it } from "vitest";
import {
	type EngineChannel,
	type EngineFrame,
	LOCAL_ENGINE_PROTOCOL,
} from "../../src/desktop-engine/channel.ts";
import { connectLocalEngine } from "../../src/desktop-engine/client.ts";
import { EngineHost } from "../../src/desktop-engine/host.ts";
import { listenLocalEngine } from "../../src/desktop-engine/listener.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = async (timeout = 1000) => {
	const token = randomBytes(32).toString("hex");
	const host = new EngineHost(timeout);
	const clients = new Map<number, EngineChannel>();
	const received: { id: number; payload: string }[] = [],
		disconnected: number[] = [];
	const listener = await listenLocalEngine({
		token,
		host,
		clients,
		onRpc: (id, payload) => {
			received.push({ id, payload });
			return true;
		},
		onDisconnect: (id) => {
			disconnected.push(id);
		},
	});
	cleanup.push(listener.close);
	return {
		host,
		clients,
		received,
		disconnected,
		endpoint: { token, version: LOCAL_ENGINE_PROTOCOL, port: listener.port },
	};
};
const hostInfo = {
	authRedirectUri: "http://localhost:8976/callback",
};

it("restores the current engine power state after native reattachment without replaying actions", async () => {
	const f = await fixture();
	const state = (
		count: number,
	): Extract<EngineFrame, { _tag: "HostState" }> => ({
		_tag: "HostState",
		computerAwake: new ComputerAwakeStatus({
			supported: true,
			mode: "auto",
			active: count > 0,
			activeAgents: count,
			remoteClients: 0,
			electronBlockerActive: false,
			caffeinateActive: count > 0,
			warning: null,
		}),
	});
	f.host.setState(state(1));
	const frames: EngineFrame[] = [];
	const first = await connectLocalEngine(f.endpoint, {
		host: hostInfo,
		receive: (frame) => {
			frames.push(frame);
		},
	});
	await expect.poll(() => frames.length).toBe(1);
	expect(frames[0]).toEqual(state(1));
	f.host.setState(state(2));
	await expect.poll(() => frames.length).toBe(2);
	expect(frames[1]).toEqual(state(2));
	first.close();
	await first.closed;
	await expect.poll(() => f.clients.size).toBe(0);
	f.host.setState(state(0));
	f.host.notify("openSession", { sessionId: "old-session" });
	frames.length = 0;
	const second = await connectLocalEngine(f.endpoint, {
		host: hostInfo,
		receive: (frame) => {
			frames.push(frame);
		},
	});
	await expect.poll(() => frames.length).toBe(1);
	expect(frames).toEqual([state(0)]);
	const readerFrames: EngineFrame[] = [];
	const reader = await connectLocalEngine(f.endpoint, {
		receive: (frame) => {
			readerFrames.push(frame);
		},
	});
	f.host.setState(state(3));
	await expect.poll(() => frames.length).toBe(2);
	expect(readerFrames).toEqual([]);
	reader.close();
	second.close();
	await Promise.all([reader.closed, second.closed]);
});

it("authenticates attachments and fences callbacks from non-host clients", async () => {
	const f = await fixture();
	await expect(
		connectLocalEngine(
			{ ...f.endpoint, token: "wrong" },
			{ receive: () => {} },
		),
	).rejects.toThrow();
	expect(f.clients.size).toBe(0);
	const frames: EngineFrame[] = [];
	const owner = await connectLocalEngine(f.endpoint, {
		host: hostInfo,
		receive: (frame) => {
			frames.push(frame);
		},
	});
	const reader = await connectLocalEngine(f.endpoint, { receive: () => {} });
	let callback: string | null = null;
	f.host.onCallback("account", (url) => {
		callback = url;
	});
	reader.send({ _tag: "HostCallback", flow: "account", url: "invalid-owner" });
	await reader.closed;
	expect(callback).toBeNull();
	const picked = f.host.request("pickFolder", null);
	await expect.poll(() => frames.length).toBe(1);
	const request = frames[0];
	if (request?._tag !== "HostRequest") throw new Error("missing request");
	owner.send({ _tag: "HostResult", id: request.id, value: "/tmp/chosen" });
	await expect(picked).resolves.toBe("/tmp/chosen");
	owner.send({ _tag: "HostCallback", flow: "account", url: "valid-owner" });
	await expect.poll(() => callback).toBe("valid-owner");
	owner.close();
	await owner.closed;
});

it("drops lost native requests and permits a new owner without replay", async () => {
	const f = await fixture();
	const frames: EngineFrame[] = [];
	const first = await connectLocalEngine(f.endpoint, {
		host: hostInfo,
		receive: (frame) => {
			frames.push(frame);
		},
	});
	const pending = f.host.request("openExternal", "https://example.com");
	const rejected = expect(pending).rejects.toThrow("disconnected");
	await expect.poll(() => frames.length).toBe(1);
	first.close();
	await first.closed;
	await rejected;
	const secondFrames: EngineFrame[] = [];
	const second = await connectLocalEngine(f.endpoint, {
		host: hostInfo,
		receive: (frame) => {
			secondFrames.push(frame);
		},
	});
	expect(secondFrames).toEqual([]);
	const old = frames[0];
	if (old?._tag !== "HostRequest") throw new Error("missing request");
	second.send({ _tag: "HostResult", id: old.id, value: true });
	second.send({ _tag: "Rpc", payload: "new-client" });
	await expect
		.poll(() => f.received.map((item) => item.payload))
		.toEqual(["new-client"]);
	second.close();
	await second.closed;
});

it("times out and cancels native work without detaching a healthy client", async () => {
	const f = await fixture(25);
	const frames: EngineFrame[] = [];
	const client = await connectLocalEngine(f.endpoint, {
		host: hostInfo,
		receive: (frame) => {
			frames.push(frame);
		},
	});
	await expect(f.host.request("pickFolder", null)).rejects.toThrow("in time");
	const abort = new AbortController();
	const work = f.host.request("pickFolder", null, abort.signal);
	abort.abort();
	await expect(work).rejects.toThrow("cancelled");
	await expect.poll(() => frames.length).toBe(4);
	expect(frames.map((frame) => frame._tag)).toEqual([
		"HostRequest",
		"HostCancel",
		"HostRequest",
		"HostCancel",
	]);
	const first = frames[0],
		second = frames[2];
	if (first?._tag !== "HostRequest" || second?._tag !== "HostRequest")
		throw new Error("missing requests");
	expect(frames[1]).toEqual({ _tag: "HostCancel", id: first.id });
	expect(frames[3]).toEqual({ _tag: "HostCancel", id: second.id });
	client.send({ _tag: "Rpc", payload: "still-connected" });
	await expect.poll(() => f.received.length).toBe(1);
	client.close();
	await client.closed;
});

it("does not let another desktop steal a live native attachment", async () => {
	const f = await fixture();
	const first = await connectLocalEngine(f.endpoint, {
		host: hostInfo,
		receive: () => {},
	});
	await expect(
		connectLocalEngine(f.endpoint, { host: hostInfo, receive: () => {} }),
	).rejects.toThrow();
	first.send({ _tag: "Rpc", payload: "original" });
	await expect.poll(() => f.received.length).toBe(1);
	first.close();
	await first.closed;
});

it.each([
	0, 4097, 0xffffffff,
])("rejects oversized unauthenticated frame headers (%s)", async (size) => {
	const f = await fixture();
	const socket = connect({ host: "127.0.0.1", port: f.endpoint.port });
	await once(socket, "connect");
	const closed = once(socket, "close");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(size);
	socket.write(length);
	await closed;
	expect(f.clients.size).toBe(0);
});

it("handles split headers, split UTF-8 text and multiple frames in one read", async () => {
	const f = await fixture();
	const socket = connect({ host: "127.0.0.1", port: f.endpoint.port });
	await once(socket, "connect");
	const encode = (frame: EngineFrame) => {
		const body = Buffer.from(JSON.stringify(frame));
		const header = Buffer.alloc(4);
		header.writeUInt32BE(body.length);
		return Buffer.concat([header, body]);
	};
	const hello = encode({
		_tag: "Hello",
		token: f.endpoint.token,
		version: 1,
		host: false,
	});
	const rpc = encode({ _tag: "Rpc", payload: "你好 👋" });
	const bytes = Buffer.concat([hello, rpc, rpc]);
	for (const byte of bytes) socket.write(Buffer.from([byte]));
	await expect
		.poll(() => f.received.map((item) => item.payload))
		.toEqual(["你好 👋", "你好 👋"]);
	socket.destroy();
});
