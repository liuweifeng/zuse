import { EventEmitter } from "node:events";
import type { IpcRenderer, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { makeEnginePreloadRpc } from "../../src/ipc/engine-preload-rpc.ts";
import { ENGINE_RPC_CHANNELS } from "../../src/ipc/engine-rpc-channels.ts";
import { installEngineServerBridge } from "../../src/ipc/engine-server-bridge.ts";

const state = vi.hoisted(() => ({
	open: vi.fn(async () => {}),
	close: vi.fn(),
	send: vi.fn(),
	reset: vi.fn(),
	dispose: vi.fn(),
}));
vi.mock("../../src/ipc/engine-rpc-connection.ts", () => ({
	makeEngineRpcConnection: () => state,
}));

it("fences main-process IPC by window and top-level frame and resets only on document replacement", async () => {
	const handles = new Map<
		string,
		(event: unknown, id: unknown) => Promise<void>
	>();
	const ipc = Object.assign(new EventEmitter(), {
		handle: (
			channel: string,
			handler: (event: unknown, id: unknown) => Promise<void>,
		) => {
			handles.set(channel, handler);
		},
		removeHandler: (channel: string) => {
			handles.delete(channel);
		},
	});
	const frame = { isDestroyed: () => false, detached: false };
	const contents = Object.assign(new EventEmitter(), {
		ipc,
		mainFrame: frame,
		isDestroyed: () => false,
		send: vi.fn(),
	});
	const installed = installEngineServerBridge(
		contents as unknown as WebContents,
		async () => {
			throw new Error("unused");
		},
	);
	const open = handles.get(ENGINE_RPC_CHANNELS.open);
	if (open === undefined) throw new Error("missing open handler");
	const trusted = { sender: contents, senderFrame: frame };
	await open(trusted, "first");
	expect(state.open).toHaveBeenCalledWith("first");
	const previousOpens = state.open.mock.calls.length;
	for (const event of [
		{ sender: {}, senderFrame: frame },
		{ sender: contents, senderFrame: {} },
	]) {
		expect(() => open(event, "intruder")).toThrow("Invalid renderer");
		ipc.emit(ENGINE_RPC_CHANNELS.request, event, "first", "malicious");
		ipc.emit(ENGINE_RPC_CHANNELS.close, event, "first");
	}
	expect(state.open).toHaveBeenCalledTimes(previousOpens);
	expect(state.send).not.toHaveBeenCalled();
	expect(state.close).not.toHaveBeenCalled();
	ipc.emit(ENGINE_RPC_CHANNELS.request, trusted, "first", "request");
	expect(state.send).toHaveBeenCalledWith("first", "request");
	contents.emit("did-start-navigation", {
		isMainFrame: false,
		isSameDocument: false,
	});
	contents.emit("did-start-navigation", {
		isMainFrame: true,
		isSameDocument: true,
	});
	expect(state.reset).not.toHaveBeenCalled();
	contents.emit("did-start-navigation", {
		isMainFrame: true,
		isSameDocument: false,
	});
	expect(state.reset).toHaveBeenCalledOnce();
	contents.emit("destroyed");
	installed.dispose();
	expect(state.dispose).toHaveBeenCalledOnce();
	expect(handles.size).toBe(0);
	expect(ipc.listenerCount(ENGINE_RPC_CHANNELS.request)).toBe(0);
	expect(ipc.listenerCount(ENGINE_RPC_CHANNELS.close)).toBe(0);
});

it("preload filters responses by connection identity and removes listeners on disposal", async () => {
	const ipc = Object.assign(new EventEmitter(), {
		invoke: vi.fn(async () => {}),
		send: vi.fn(),
	});
	const bridge = makeEnginePreloadRpc(ipc as unknown as IpcRenderer);
	await bridge.connect("current");
	expect(ipc.invoke).toHaveBeenCalledWith(ENGINE_RPC_CHANNELS.open, "current");
	const received: unknown[] = [];
	const off = bridge.onMessage((message) => {
		received.push(message);
	}, "current");
	ipc.emit(ENGINE_RPC_CHANNELS.response, {}, "previous", "stale response");
	ipc.emit(ENGINE_RPC_CHANNELS.response, {}, "current", { invalid: true });
	ipc.emit(ENGINE_RPC_CHANNELS.response, {}, "current", "response");
	expect(received).toEqual(["response"]);
	bridge.send("request", "current");
	expect(ipc.send).toHaveBeenCalledWith(
		ENGINE_RPC_CHANNELS.request,
		"current",
		"request",
	);
	expect(() => bridge.send("request")).toThrow("connection is required");
	const closed: string[] = [];
	const offClose = bridge.onDisconnect((id) => {
		closed.push(id);
	});
	ipc.emit(ENGINE_RPC_CHANNELS.disconnected, {}, null);
	ipc.emit(ENGINE_RPC_CHANNELS.disconnected, {}, "current");
	expect(closed).toEqual(["current"]);
	bridge.disconnect("current");
	expect(ipc.send).toHaveBeenCalledWith(ENGINE_RPC_CHANNELS.close, "current");
	off();
	offClose();
	expect(ipc.listenerCount(ENGINE_RPC_CHANNELS.response)).toBe(0);
	expect(ipc.listenerCount(ENGINE_RPC_CHANNELS.disconnected)).toBe(0);
});
