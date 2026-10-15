import { cloudImageRuntimeBehind } from "@zuse/client-runtime/cloud-sandbox-providers";
import {
	type CloudAccountImage,
	EnvironmentId,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import { useSyncExternalStore } from "react";
import { useChatsStore } from "../store/chats.ts";
import { cloudSummaryForChat } from "./cloud-workspace-catalog.ts";
import { runCloudControl } from "./control-plane-client.ts";
import { environmentShellSnapshot } from "./environment-shell-client-bus.ts";
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
const workspaceUpdates = new Map<
	string,
	{ readonly client: object; readonly request: Promise<boolean> }
>();
const waitingWorkspaces = new Map<string, ReturnType<typeof setTimeout>>();

// The server abandons an update after its preparation and activation
// deadlines (10 + 2 minutes); sending must not stay blocked past that.
const RUNTIME_UPDATE_SEND_BLOCK_MS = 12 * 60_000;
const updatingWorkspaces = new Map<string, ReturnType<typeof setTimeout>>();
const updatingListeners = new Set<() => void>();

const setRuntimeUpdating = (workspaceId: string, updating: boolean) => {
	const timer = updatingWorkspaces.get(workspaceId);
	if (timer === undefined && !updating) return;
	clearTimeout(timer);
	if (updating)
		updatingWorkspaces.set(
			workspaceId,
			setTimeout(
				() => setRuntimeUpdating(workspaceId, false),
				RUNTIME_UPDATE_SEND_BLOCK_MS,
			),
		);
	else updatingWorkspaces.delete(workspaceId);
	for (const listener of updatingListeners) listener();
};

const subscribeRuntimeUpdating = (listener: () => void) => {
	updatingListeners.add(listener);
	return () => {
		updatingListeners.delete(listener);
	};
};

/**
 * True from an update request until the workspace reconnects. A turn sent
 * meanwhile would start on the old runtime and be cut off by its restart.
 */
export const cloudRuntimeUpdating = (workspaceId: string): boolean =>
	updatingWorkspaces.has(workspaceId);

export const useCloudRuntimeUpdating = (workspaceId: string | null): boolean =>
	useSyncExternalStore(
		subscribeRuntimeUpdating,
		() => workspaceId !== null && cloudRuntimeUpdating(workspaceId),
		() => false,
	);

subscribeRendererAccount(() => {
	requestedImages.clear();
	workspaceUpdates.clear();
	for (const timer of waitingWorkspaces.values()) clearTimeout(timer);
	waitingWorkspaces.clear();
	for (const workspaceId of [...updatingWorkspaces.keys()])
		setRuntimeUpdating(workspaceId, false);
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
 * Replaces the runtime of a connected workspace. Resolves true while that
 * connection's update is in flight. A rejected request may be retried, but an
 * accepted one is never repeated: a later connection that is still legacy
 * means the update rolled back, and it must not loop.
 */
export const requestCloudWorkspaceRuntimeUpdate = (
	workspaceId: string,
	client: object,
): Promise<boolean> => {
	const existing = workspaceUpdates.get(workspaceId);
	if (existing !== undefined)
		return existing.client === client
			? existing.request
			: Promise.resolve(false);
	// Block sending before the request leaves: the restart can follow quickly.
	setRuntimeUpdating(workspaceId, true);
	const request = runCloudControl((control) =>
		control["cloud.workspaces.update"]({
			workspaceId,
			commandId: `runtime-catch-up:${crypto.randomUUID()}`,
		}),
	).then(
		() => true,
		() => {
			if (workspaceUpdates.get(workspaceId)?.request === request) {
				workspaceUpdates.delete(workspaceId);
				setRuntimeUpdating(workspaceId, false);
			}
			return false;
		},
	);
	workspaceUpdates.set(workspaceId, { client, request });
	return request;
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
	setRuntimeUpdating(workspaceId, false);
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
