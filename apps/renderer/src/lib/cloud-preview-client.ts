import {
	DEFAULT_PREVIEW_SETTINGS,
	usePreviewSettings,
} from "../store/preview-settings.ts";
import { runControlPlane } from "./control-plane-client.ts";
import { createPreviewPublication } from "./preview-publication.ts";

const publications = new Map<
	string,
	ReturnType<typeof createPreviewPublication>
>();
const settingsFor = (id: string) =>
	usePreviewSettings.getState().environments[id] ?? DEFAULT_PREVIEW_SETTINGS;
const update = (
	id: string,
	patch: Parameters<
		ReturnType<typeof usePreviewSettings.getState>["update"]
	>[1],
	requirePersistence = false,
) => usePreviewSettings.getState().update(id, patch, requirePersistence);

export const cloudPreviewPublication = (workspaceId: string) => {
	let publication = publications.get(workspaceId);
	if (publication) return publication;
	publication = createPreviewPublication({
		publish: async (port) =>
			(
				await runControlPlane((client) =>
					client["cloud.workspaces.previewUrl"]({ workspaceId, port }),
				)
			).url,
		revoke: (port) =>
			runControlPlane((client) =>
				client["cloud.workspaces.revokePreviewUrl"]({ workspaceId, port }),
			),
		ports: () => settingsFor(workspaceId).publishedPorts,
		remember: (port) =>
			update(
				workspaceId,
				{
					publishedPorts: [
						...new Set([...settingsFor(workspaceId).publishedPorts, port]),
					],
				},
				true,
			),
		forget: (port) =>
			update(workspaceId, {
				publishedPorts: settingsFor(workspaceId).publishedPorts.filter(
					(value) => value !== port,
				),
			}),
		pending: (revocationPending) => update(workspaceId, { revocationPending }),
	});
	publications.set(workspaceId, publication);
	return publication;
};

export const getCloudPreviewUrl = async (
	workspaceId: string,
	port: number,
	managed = true,
) => ({
	workspaceId,
	port,
	expiresAt: null,
	url: !managed
		? (
				await runControlPlane((client) =>
					client["cloud.workspaces.previewUrl"]({ workspaceId, port }),
				)
			).url
		: await cloudPreviewPublication(workspaceId).publish(port, () => {
				const settings = settingsFor(workspaceId);
				return settings.publish && !settings.revocationPending;
			}),
});

export const revokeCloudPreviewUrls = (workspaceId: string): Promise<void> => {
	update(workspaceId, { publish: false, revocationPending: true });
	return cloudPreviewPublication(workspaceId).revoke();
};

for (const [id, settings] of Object.entries(
	usePreviewSettings.getState().environments,
)) {
	if (settings.publishedPorts.length > 0 || settings.revocationPending) {
		update(id, { revocationPending: true });
		void cloudPreviewPublication(id)
			.revoke()
			.catch(() => {});
	}
}
