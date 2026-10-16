import { cloudImageRuntimeBehind } from "@zuse/client-runtime/cloud-image-runtime";
import { cloudRuntimeUpdateInProgress } from "@zuse/client-runtime/cloud-startup-presentation";
import { getClientProtocolVersion } from "@zuse/client-runtime/connection";
import { supportsStartedProviderHandoff } from "@zuse/client-runtime/legacy-runtime-capabilities";
import {
	type CloudAccountImage,
	EnvironmentId,
	type SessionId,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import { useChatsStore } from "../store/chats.ts";
import {
	clearCloudRuntimeUpdating,
	setCloudRuntimeUpdating,
	subscribeCloudRuntimeConnections,
} from "./cloud-runtime-updating.ts";
import {
	cloudSummaryForChat,
	cloudSummaryForEnvironment,
} from "./cloud-workspace-catalog.ts";
import { runCloudControl } from "./control-plane-client.ts";
import { environmentShellSnapshot } from "./environment-shell-client-bus.ts";
import { RuntimeUpdatePendingError } from "./pending-model-change.ts";
import { subscribeRendererAccount } from "./renderer-account.ts";
import { getRpcClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	sessionTimelineResourceKey,
} from "./session-timeline-client-bus.ts";

/**
 * Cloud images and sandboxes keep the runtime they were built with. When this
 * app speaks a newer protocol, it brings them forward in the background:
 * images get one update build per provider and protocol, and connected idle
 * chats are updated in place. Nothing here blocks startup; only sending in
 * a chat whose runtime is being replaced waits for the new runtime.
 */

const requestedImages = new Set<string>();
type WorkspaceUpdate = {
	readonly client: object;
	request: Promise<boolean>;
	settled: boolean;
};
const workspaceUpdates = new Map<string, WorkspaceUpdate>();

// A reconnect alone says nothing about the update: the request may still be in
// flight, or the server may still be preparing or restarting the runtime.
const updateInProgress = (workspaceId: string, update: WorkspaceUpdate) =>
	!update.settled ||
	cloudRuntimeUpdateInProgress(
		cloudSummaryForEnvironment(workspaceId)?.statusCode ?? "",
	);

const waitingWorkspaces = new Map<string, ReturnType<typeof setTimeout>>();

subscribeRendererAccount(() => {
	requestedImages.clear();
	workspaceUpdates.clear();
	for (const timer of waitingWorkspaces.values()) clearTimeout(timer);
	waitingWorkspaces.clear();
	clearCloudRuntimeUpdating();
});

export const catchUpCloudImageRuntimes = (
	images: readonly CloudAccountImage[],
): void => {
	for (const image of images) {
		const providerId = image.providerId;
		if (
			providerId === undefined ||
			!cloudImageRuntimeBehind(image, WIRE_PROTOCOL_VERSION)
		)
			continue;
		// The server dedupes this key per account and provider, so other devices
		// and restarts never queue a second build for the same protocol.
		const idempotencyKey = `runtime-catch-up:${providerId}:${WIRE_PROTOCOL_VERSION}`;
		if (requestedImages.has(idempotencyKey)) continue;
		requestedImages.add(idempotencyKey);
		void runCloudControl((client) =>
			client["cloud.image.build"]({
				mode: "update",
				providerId,
				idempotencyKey,
			}),
		).catch(() => undefined);
	}
};

/**
 * Replaces the runtime of a connected workspace. Resolves true while the
 * update is in progress. A rejected request may be retried, but an accepted
 * one is never repeated: a later legacy connection after the update finished
 * means it rolled back, and it must not loop.
 */
export const requestCloudWorkspaceRuntimeUpdate = (
	workspaceId: string,
	client: object,
): Promise<boolean> => {
	const existing = workspaceUpdates.get(workspaceId);
	if (existing !== undefined)
		return existing.client === client
			? existing.request
			: Promise.resolve(updateInProgress(workspaceId, existing));
	// Block sending before the request leaves: the restart can follow quickly.
	setCloudRuntimeUpdating(workspaceId, true);
	const update: WorkspaceUpdate = {
		client,
		request: Promise.resolve(false),
		settled: false,
	};
	update.request = runCloudControl((control) =>
		control["cloud.workspaces.update"]({
			workspaceId,
			commandId: `runtime-catch-up:${crypto.randomUUID()}`,
		}),
	).then(
		() => {
			update.settled = true;
			return true;
		},
		() => {
			update.settled = true;
			if (workspaceUpdates.get(workspaceId) === update) {
				workspaceUpdates.delete(workspaceId);
				setCloudRuntimeUpdating(workspaceId, false);
			}
			return false;
		},
	);
	workspaceUpdates.set(workspaceId, update);
	return update.request;
};

/**
 * Retained cloud runtimes reject provider changes once the chat has started.
 * Update the runtime in place; the selection applies after it reconnects.
 */
export const awaitCloudProviderHandoff = async (ref: {
	environmentId: EnvironmentId;
	sessionId: SessionId;
}): Promise<void> => {
	const client = await getRpcClient(ref.environmentId);
	if (supportsStartedProviderHandoff(getClientProtocolVersion(client))) return;
	const timeline = getRendererClientBus().snapshot(
		sessionTimelineResourceKey(ref),
	).data;
	const started =
		timeline !== null &&
		(timeline.turnCount > 0 ||
			timeline.messages.some((message) => message.role === "user"));
	if (!started) return;
	// When no update can start, the runtime's own rejection explains why.
	if (await requestCloudWorkspaceRuntimeUpdate(ref.environmentId, client))
		throw new RuntimeUpdatePendingError();
};

const BACKGROUND_UPDATE_DELAY_MS = 60_000;

const cloudWorkspaceSelected = (workspaceId: string): boolean => {
	const chatId = useChatsStore.getState().selectedChatId;
	return (
		chatId !== null && cloudSummaryForChat(chatId)?.workspaceId === workspaceId
	);
};

// Only a live, connected workspace with no turn, queue or pending command is
// safe to restart; a paused one stays paused instead of being woken.
const cloudWorkspaceIdle = (workspaceId: string): boolean => {
	const environmentId = EnvironmentId.make(workspaceId);
	const shell = environmentShellSnapshot({ environmentId });
	if (
		shell.connection !== "connected" ||
		shell.sync !== "live" ||
		shell.data === null
	)
		return false;
	const bus = getRendererClientBus();
	return Object.values(shell.data.sessionsByProject)
		.flat()
		.every((session) => {
			if (session.status === "running" || session.status === "booting")
				return false;
			const timeline = bus.snapshot(
				sessionTimelineResourceKey({ environmentId, sessionId: session.id }),
			);
			return (
				timeline.pendingCommands.length === 0 &&
				(timeline.data === null ||
					(timeline.data.activeTurn === null &&
						timeline.data.queue.items.length === 0))
			);
		});
};

/**
 * Called for every negotiated workspace connection. A new connection ends any
 * runtime replacement in progress. On an older protocol, the chat on screen is
 * left alone so a restart never surprises the user mid-thought; it updates on
 * demand when it needs a newer runtime feature.
 */
export const noteCloudRuntimeConnection = (
	workspaceId: string,
	protocolVersion: number,
): void => {
	const update = workspaceUpdates.get(workspaceId);
	// A reconnect mid-update (network loss) keeps sending held.
	if (
		protocolVersion >= WIRE_PROTOCOL_VERSION ||
		update === undefined ||
		!updateInProgress(workspaceId, update)
	)
		setCloudRuntimeUpdating(workspaceId, false);
	if (protocolVersion >= WIRE_PROTOCOL_VERSION) return;
	if (workspaceUpdates.has(workspaceId) || waitingWorkspaces.has(workspaceId))
		return;
	const attempt = async () => {
		waitingWorkspaces.delete(workspaceId);
		if (workspaceUpdates.has(workspaceId)) return;
		const shell = environmentShellSnapshot({
			environmentId: EnvironmentId.make(workspaceId),
		});
		// Disconnected or paused: the next connection notes it again.
		if (shell.connection !== "connected") return;
		if (
			!cloudWorkspaceSelected(workspaceId) &&
			cloudWorkspaceIdle(workspaceId)
		) {
			const client = await getRpcClient(workspaceId).catch(() => null);
			if (client !== null)
				void requestCloudWorkspaceRuntimeUpdate(workspaceId, client);
			return;
		}
		schedule();
	};
	const schedule = () =>
		waitingWorkspaces.set(
			workspaceId,
			setTimeout(() => void attempt(), BACKGROUND_UPDATE_DELAY_MS),
		);
	schedule();
};

subscribeCloudRuntimeConnections(noteCloudRuntimeConnection);
