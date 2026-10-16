import { withoutResponseHeaders } from "./http.ts";
import type { makeApi } from "./index.ts";

export type ResponseEffectsApi = Pick<
	ReturnType<typeof makeApi>,
	| "dispose"
	| "reconcileMachine"
	| "reconcileCloudBuild"
	| "reconcileCloudWorkspaceStartup"
	| "startCloudWorkspaceInline"
	| "deliverApiWebhooks"
>;

/** Shared post-operation work for public requests and first-party integrations. */
export const applyResponseEffects = async (
	response: Response,
	api: ResponseEffectsApi,
	nudgeGateway: (target: string) => Promise<unknown>,
	context: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> => {
	const machineId = response.headers.get("x-zuse-reconcile-machine");
	const cloudBuildId = response.headers.get("x-zuse-reconcile-cloud-build");
	const cloudBuildIds =
		cloudBuildId
			?.split(",")
			.map((value) => value.trim())
			.filter(Boolean) ?? [];
	const cloudWorkspaceId = response.headers.get(
		"x-zuse-reconcile-cloud-workspace",
	);
	const gatewayNudgeTarget = response.headers.get(
		"x-zuse-nudge-cloud-workspace",
	);
	const webhookDeliveryAccountId = response.headers.get(
		"x-zuse-deliver-cloud-webhooks",
	);
	response = withoutResponseHeaders(response, [
		"x-zuse-reconcile-machine",
		"x-zuse-reconcile-cloud-build",
		"x-zuse-reconcile-cloud-workspace",
		"x-zuse-nudge-cloud-workspace",
		"x-zuse-deliver-cloud-webhooks",
	]);
	let inlineStartup: Promise<unknown> | null = null;
	if (cloudWorkspaceId !== null) {
		inlineStartup = api
			.startCloudWorkspaceInline(cloudWorkspaceId)
			.then((ran) =>
				ran ? api.reconcileCloudWorkspaceStartup(cloudWorkspaceId) : undefined,
			)
			.catch((error) => {
				console.error("[api] inline workspace startup failed", error);
			});
		try {
			await api.reconcileCloudWorkspaceStartup(cloudWorkspaceId);
		} catch (error) {
			await inlineStartup;
			await api.dispose();
			throw error;
		}
	}
	if (
		machineId === null &&
		cloudBuildId === null &&
		gatewayNudgeTarget === null &&
		webhookDeliveryAccountId === null &&
		inlineStartup === null
	) {
		await api.dispose();
		return response;
	}
	context.waitUntil(
		Promise.allSettled([
			inlineStartup ?? Promise.resolve(),
			machineId === null
				? Promise.resolve()
				: api.reconcileMachine(machineId, `webhook-${crypto.randomUUID()}`),
			...cloudBuildIds.map((buildId) => api.reconcileCloudBuild(buildId)),
			gatewayNudgeTarget === null
				? Promise.resolve()
				: nudgeGateway(gatewayNudgeTarget),
			webhookDeliveryAccountId === null
				? Promise.resolve()
				: api.deliverApiWebhooks().catch((error) => {
						console.error("[public-api] webhook delivery failed", error);
						return 0;
					}),
		])
			.then((results) => {
				if (results.some((result) => result.status === "rejected"))
					console.error(
						"[api] background reconciliation failed; maintenance will retry",
					);
			})
			.finally(() => api.dispose()),
	);
	return response;
};
