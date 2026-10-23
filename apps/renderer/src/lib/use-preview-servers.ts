import type { CloudChatSummary } from "@zuse/contracts";
import { useCallback, useSyncExternalStore } from "react";
import {
	DEFAULT_PREVIEW_SETTINGS,
	usePreviewSettings,
} from "../store/preview-settings.ts";
import {
	cloudPreviewPublication,
	getCloudPreviewUrl,
} from "./cloud-preview-client.ts";
import { useCloudChatCatalogStore } from "./cloud-workspace-catalog.ts";
import { ensurePreviewPortForward } from "./port-forward-client.ts";
import { createPreviewDiscovery, EMPTY_PREVIEWS } from "./preview-discovery.ts";
import { runRuntimeOperation } from "./runtime-operation-client.ts";

const discoveries = new Map<
	string,
	ReturnType<typeof createPreviewDiscovery>
>();

const previewReady = (summary: CloudChatSummary) =>
	summary.state === "ready" &&
	summary.runtimeState === "online" &&
	summary.archivedAt === undefined;

export const useBoxdPreviewEnabled = (environmentId: string): boolean =>
	useCloudChatCatalogStore((state) =>
		state.summaries.some(
			(summary) =>
				summary.workspaceId === environmentId &&
				summary.providerId === "boxd" &&
				previewReady(summary),
		),
	);

export const usePreviewServers = (
	environmentId: string,
	enabled: boolean,
	publish: boolean,
) => {
	const unavailable = useCloudChatCatalogStore((state) =>
		state.summaries.some(
			(summary) =>
				summary.workspaceId === environmentId && !previewReady(summary),
		),
	);
	const settings = usePreviewSettings(
		(state) => state.environments[environmentId] ?? DEFAULT_PREVIEW_SETTINGS,
	);
	const autoPublish =
		publish && settings.publish && !settings.revocationPending;
	const forward = settings.forward;
	const portsKey = settings.ports.join(",");
	const active = enabled && !unavailable;
	const key = JSON.stringify([environmentId, autoPublish, forward, portsKey]);
	const subscribe = useCallback(
		(listener: () => void) => {
			if (!active) return () => {};
			let discovery = discoveries.get(key);
			if (discovery === undefined) {
				const release = autoPublish
					? cloudPreviewPublication(environmentId).retain()
					: undefined;
				discovery = createPreviewDiscovery({
					onIdle: () => {
						discoveries.delete(key);
						release?.();
					},

					list: async () => {
						const manualPorts =
							portsKey === "" ? [] : portsKey.split(",").map(Number);
						let detected: ReadonlyArray<
							import("./preview-discovery.ts").DiscoveredPreview
						>;
						try {
							detected = (
								await runRuntimeOperation(environmentId, (client) =>
									client["previews.listServers"](),
								)
							).servers;
						} catch (cause) {
							if (manualPorts.length === 0) throw cause;
							detected = [];
						}
						const merged = new Map(
							detected.map((server) => [server.port, server]),
						);
						for (const port of manualPorts)
							merged.set(port, {
								...(merged.get(port) ?? {
									name: "localhost",
									port,
									loopbackOnly: true,
								}),
								explicitlyRequested: true,
							});
						return [...merged.values()].sort((a, b) => a.port - b.port);
					},
					...(forward
						? {
								forward: (port: number) =>
									ensurePreviewPortForward(
										environmentId,
										port,
										() =>
											usePreviewSettings.getState().environments[environmentId]
												?.forward === true,
									),
							}
						: {}),
					...(autoPublish
						? {
								publish: async (port: number) =>
									(await getCloudPreviewUrl(environmentId, port)).url,
							}
						: {}),
				});
				discoveries.set(key, discovery);
			}
			return discovery.subscribe(listener);
		},
		[key, environmentId, active, autoPublish, forward, portsKey],
	);
	const snapshot = useCallback(
		() =>
			active
				? (discoveries.get(key)?.getSnapshot() ?? EMPTY_PREVIEWS)
				: EMPTY_PREVIEWS,
		[active, key],
	);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
};
