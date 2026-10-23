import { getTunnelsBridge } from "./bridge.ts";
import { prepareCloudWorkspaceSsh } from "./cloud-ssh-client-bus.ts";
import {
	getLocalEnvironmentId,
	isCloudWorkspaceEnvironment,
} from "./rpc-client.ts";

export const cloudAccessForwardFailure = (cause: unknown): boolean => {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return /(?:zuse ssh bridge:|permission denied|connection (?:unexpectedly )?(?:closed|reset|timed out)|kex_exchange_identification|no route to host|could not resolve hostname|tunnel timed out before it became ready)/iu.test(
		detail,
	);
};

/**
 * Ensure a dev server port on the given environment is reachable locally and
 * return the local port to open. Local environments need no forward; cloud
 * and SSH environments get an idempotent tunnel from the desktop main
 * process. Cloud forwards refresh the workspace SSH ticket first, so an
 * expired ticket never surfaces as a dead tunnel.
 */
export const ensurePortForward = async (
	environmentId: string,
	remotePort: number,
	owner?: "preview",
): Promise<number> => {
	if (environmentId === getLocalEnvironmentId()) return remotePort;
	const tunnels = getTunnelsBridge();
	if (tunnels === undefined) {
		throw new Error("Previewing remote servers requires the Zuse desktop app.");
	}
	const live = (await tunnels.list(environmentId)).find(
		(forward) => forward.remotePort === remotePort,
	);
	if (live !== undefined)
		return (
			await tunnels.open({
				environmentId,
				remotePort,
				...(isCloudWorkspaceEnvironment(environmentId)
					? { cloudWorkspaceId: environmentId }
					: {}),
				...(owner ? { owner } : {}),
			})
		).localPort;
	if (isCloudWorkspaceEnvironment(environmentId)) {
		await prepareCloudWorkspaceSsh(environmentId);
		try {
			const forward = await tunnels.open({
				environmentId,
				remotePort,
				cloudWorkspaceId: environmentId,
				...(owner ? { owner } : {}),
			});
			return forward.localPort;
		} catch (cause) {
			if (!cloudAccessForwardFailure(cause)) throw cause;

			await prepareCloudWorkspaceSsh(environmentId);
			const forward = await tunnels.open({
				environmentId,
				remotePort,
				cloudWorkspaceId: environmentId,
				...(owner ? { owner } : {}),
			});
			return forward.localPort;
		}
	}
	const forward = await tunnels.open({
		environmentId,
		remotePort,
		...(owner ? { owner } : {}),
	});
	return forward.localPort;
};

const previewForwardTasks = new Map<string, Promise<unknown>>();
const queuePreviewForward = <T>(
	environmentId: string,
	work: () => Promise<T>,
): Promise<T> => {
	const task = (previewForwardTasks.get(environmentId) ?? Promise.resolve())
		.catch(() => {})
		.then(work);
	previewForwardTasks.set(environmentId, task);
	void task
		.finally(() => {
			if (previewForwardTasks.get(environmentId) === task)
				previewForwardTasks.delete(environmentId);
		})
		.catch(() => {});
	return task;
};
export const ensurePreviewPortForward = (
	environmentId: string,
	port: number,
	enabled: () => boolean,
): Promise<number> =>
	queuePreviewForward(environmentId, () => {
		if (!enabled()) throw new Error("Port forwarding is disabled.");
		return ensurePortForward(environmentId, port, "preview");
	});
export const closePreviewPortForwards = (
	environmentId: string,
): Promise<void> =>
	queuePreviewForward(environmentId, async () => {
		const tunnels = getTunnelsBridge();
		if (!tunnels) return;
		await tunnels.closePreviews(environmentId);
	});
