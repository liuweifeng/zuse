import type { IpcRenderer, IpcRendererEvent } from "electron";
import { ENGINE_RPC_CHANNELS } from "./engine-rpc-channels.ts";

/** Connection IDs are renderer scopes, never engine credentials. */
export const makeEnginePreloadRpc = (ipc: IpcRenderer) => ({
	connect: (id: string): Promise<void> =>
		ipc.invoke(ENGINE_RPC_CHANNELS.open, id),
	disconnect: (id: string): void => ipc.send(ENGINE_RPC_CHANNELS.close, id),
	send: (frame: string | Uint8Array, id?: string): void => {
		if (id === undefined)
			throw new Error("A local engine connection is required.");
		ipc.send(ENGINE_RPC_CHANNELS.request, id, frame);
	},
	onMessage: (handler: (frame: string | Uint8Array) => void, id?: string) => {
		if (id === undefined)
			throw new Error("A local engine connection is required.");
		const listener = (
			_event: IpcRendererEvent,
			receivedId: unknown,
			payload: unknown,
		) => {
			if (receivedId === id && typeof payload === "string") handler(payload);
		};
		ipc.on(ENGINE_RPC_CHANNELS.response, listener);
		return () => {
			ipc.off(ENGINE_RPC_CHANNELS.response, listener);
		};
	},
	onDisconnect: (handler: (id: string) => void) => {
		const listener = (_event: IpcRendererEvent, id: unknown) => {
			if (typeof id === "string") handler(id);
		};
		ipc.on(ENGINE_RPC_CHANNELS.disconnected, listener);
		return () => {
			ipc.off(ENGINE_RPC_CHANNELS.disconnected, listener);
		};
	},
});
