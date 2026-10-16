import { useSyncExternalStore } from "react";

/**
 * Workspaces whose runtime is being replaced. A turn sent meanwhile would
 * start on the old runtime and be cut off by its restart, so the composer
 * holds sending. Kept dependency-free so the composer and RPC layer stay
 * light; the catch-up logic loads lazily and subscribes to connections.
 */

// The server abandons an update after its preparation and activation
// deadlines (10 + 2 minutes); sending must not stay blocked past that.
const RUNTIME_UPDATE_SEND_BLOCK_MS = 12 * 60_000;
const updatingWorkspaces = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

export const setCloudRuntimeUpdating = (
	workspaceId: string,
	updating: boolean,
): void => {
	const timer = updatingWorkspaces.get(workspaceId);
	if (timer === undefined && !updating) return;
	clearTimeout(timer);
	if (updating)
		updatingWorkspaces.set(
			workspaceId,
			setTimeout(
				() => setCloudRuntimeUpdating(workspaceId, false),
				RUNTIME_UPDATE_SEND_BLOCK_MS,
			),
		);
	else updatingWorkspaces.delete(workspaceId);
	for (const listener of listeners) listener();
};

export const clearCloudRuntimeUpdating = (): void => {
	for (const workspaceId of [...updatingWorkspaces.keys()])
		setCloudRuntimeUpdating(workspaceId, false);
};

export const cloudRuntimeUpdating = (workspaceId: string): boolean =>
	updatingWorkspaces.has(workspaceId);

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

export const useCloudRuntimeUpdating = (workspaceId: string | null): boolean =>
	useSyncExternalStore(
		subscribe,
		() => workspaceId !== null && cloudRuntimeUpdating(workspaceId),
		() => false,
	);

type ConnectionListener = (
	workspaceId: string,
	protocolVersion: number,
) => void;
const negotiatedVersions = new Map<string, number>();
const connectionListeners = new Set<ConnectionListener>();

/** Called by the RPC layer for every negotiated cloud workspace connection. */
export const reportCloudRuntimeConnection = (
	workspaceId: string,
	protocolVersion: number,
): void => {
	negotiatedVersions.set(workspaceId, protocolVersion);
	for (const listener of connectionListeners)
		listener(workspaceId, protocolVersion);
};

/** Replays connections negotiated before the subscriber loaded. */
export const subscribeCloudRuntimeConnections = (
	listener: ConnectionListener,
): (() => void) => {
	connectionListeners.add(listener);
	for (const [workspaceId, protocolVersion] of negotiatedVersions)
		listener(workspaceId, protocolVersion);
	return () => {
		connectionListeners.delete(listener);
	};
};
