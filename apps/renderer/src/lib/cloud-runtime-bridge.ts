import type { EnvironmentId, SessionId } from "@zuse/contracts";

/**
 * The only cloud runtime catch-up code on the default route: the RPC layer
 * and session store call in here, and the catch-up logic (loaded with the
 * chat composer) connects once it loads.
 */

type ConnectionListener = (
	workspaceId: string,
	protocolVersion: number,
) => void;
type ProviderHandoff = (ref: {
	environmentId: EnvironmentId;
	sessionId: SessionId;
}) => Promise<void>;

const negotiatedVersions = new Map<string, number>();
let onConnection: ConnectionListener | undefined;
let providerHandoff: ProviderHandoff | undefined;

/** Called by the RPC layer for every negotiated cloud workspace connection. */
export const reportCloudRuntimeConnection: ConnectionListener = (
	workspaceId,
	protocolVersion,
) => {
	negotiatedVersions.set(workspaceId, protocolVersion);
	onConnection?.(workspaceId, protocolVersion);
};

/** Replays connections negotiated before the catch-up logic loaded. */
export const connectCloudRuntimeCatchUp = (
	listener: ConnectionListener,
	handoff: ProviderHandoff,
): void => {
	onConnection = listener;
	providerHandoff = handoff;
	for (const [workspaceId, protocolVersion] of negotiatedVersions)
		listener(workspaceId, protocolVersion);
};

/** Resolves immediately until the catch-up logic has loaded. */
export const awaitCloudProviderHandoff: ProviderHandoff = (ref) =>
	providerHandoff?.(ref) ?? Promise.resolve();
