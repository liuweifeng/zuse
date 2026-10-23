import { cloudWorkspaceIsStarting } from "@zuse/client-runtime/cloud-startup-presentation";
import type { ConnectionPhase } from "@zuse/client-runtime/resource-state";
import type { CloudChatSummary } from "@zuse/contracts";
import type { CloudChatActivity } from "./cloud-chat-activity.ts";

export type CloudConnectionPresentation =
	| "hidden"
	| "paused"
	| "resuming"
	| "updating"
	| "update-required"
	| "detached"
	| "failed";

export const cloudConnectionPresentation = (
	summary: CloudChatSummary,
	activity: CloudChatActivity,
	connection: ConnectionPhase,
): CloudConnectionPresentation => {
	if (connection === "update-required") return "update-required";
	if (
		connection === "failed" &&
		(activity === "running" || activity === "stopping")
	)
		return "detached";
	if (activity === "failed") {
		if (
			connection === "failed" &&
			summary.state === "ready" &&
			summary.runtimeState === "online"
		)
			return "detached";

		if (
			summary.state !== "failed" &&
			connection !== "failed" &&
			connection !== "blocked-auth" &&
			connection !== "revoked"
		)
			return "hidden";
		return "failed";
	}
	if (activity === "paused") return "paused";
	if (summary.statusCode.includes("runtime-update")) return "updating";
	if (activity === "resuming")
		return connection === "failed" && !cloudWorkspaceIsStarting(summary)
			? "failed"
			: "resuming";

	if (activity === "attaching") return "hidden";
	return "hidden";
};
