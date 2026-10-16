import { makeCloudCommandTransport } from "@zuse/client-runtime/cloud-command-transport";
import { getCloudControlClient } from "./cloud-control-client.ts";
import { cloudSummaryForEnvironment } from "./cloud-workspace-catalog.ts";
import { getCloudWorkspaceScope } from "./rpc-client.ts";

export const cloudCommandTransport = makeCloudCommandTransport(
	async (workspaceId) => {
		const registered = getCloudWorkspaceScope(workspaceId);
		const summary = cloudSummaryForEnvironment(workspaceId);
		const scope =
			registered ??
			(summary === null
				? undefined
				: (summary.workspaceScope ?? { kind: "personal" as const }));

		if (scope === undefined)
			throw new Error("Cloud workspace ownership is not available yet.");
		return getCloudControlClient(scope);
	},
);
