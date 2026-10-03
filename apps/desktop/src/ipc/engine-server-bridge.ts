import type { DesktopEngineEndpoint } from "@zusehq/server/desktop-engine";
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { ENGINE_RPC_CHANNELS } from "./engine-rpc-channels.ts";
import { makeEngineRpcConnection } from "./engine-rpc-connection.ts";

/** Install before navigation; only this window's top-level renderer can attach. */
export const installEngineServerBridge = (
	contents: WebContents,
	endpoint: (signal: AbortSignal) => Promise<DesktopEngineEndpoint>,
) => {
	const ipc = contents.ipc;
	const send = (channel: string, ...args: unknown[]): boolean => {
		try {
			if (contents.isDestroyed()) return false;
			const frame = contents.mainFrame;
			if (frame === null || frame.isDestroyed() || frame.detached) return false;
			contents.send(channel, ...args);
			return true;
		} catch {
			// Chromium can dispose the native frame between inspection and send.
			return false;
		}
	};
	const connection = makeEngineRpcConnection({
		endpoint,
		message: (id, payload) => {
			if (!send(ENGINE_RPC_CHANNELS.response, id, payload)) connection.reset();
		},
		disconnected: (id) => send(ENGINE_RPC_CHANNELS.disconnected, id),
	});
	const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
		!contents.isDestroyed() &&
		event.sender === contents &&
		event.senderFrame === contents.mainFrame;
	const request = (event: IpcMainEvent, id: unknown, payload: unknown) => {
		if (trusted(event) && typeof id === "string") connection.send(id, payload);
	};
	const close = (event: IpcMainEvent, id: unknown) => {
		if (trusted(event) && typeof id === "string") connection.close(id);
	};
	const navigate = (
		event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
	) => {
		if (event.isMainFrame && !event.isSameDocument) connection.reset();
	};
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		connection.dispose();
		ipc.removeHandler(ENGINE_RPC_CHANNELS.open);
		ipc.off(ENGINE_RPC_CHANNELS.request, request);
		ipc.off(ENGINE_RPC_CHANNELS.close, close);
		contents.off("did-start-navigation", navigate);
		contents.off("destroyed", dispose);
	};
	ipc.handle(ENGINE_RPC_CHANNELS.open, (event, id: unknown) => {
		if (!trusted(event) || typeof id !== "string")
			throw new Error("Invalid renderer connection.");
		return connection.open(id);
	});
	ipc.on(ENGINE_RPC_CHANNELS.request, request);
	ipc.on(ENGINE_RPC_CHANNELS.close, close);
	contents.on("did-start-navigation", navigate);
	contents.once("destroyed", dispose);
	return { dispose };
};
