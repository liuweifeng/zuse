import type { ConnectionPhase } from "@zuse/client-runtime/resource-state";
import type { CloudChatSummary } from "@zuse/contracts";
import type { MessageKey } from "@zuse/i18n";
import type { CloudChatActivity } from "./cloud-chat-activity.ts";

/** Lifecycle diagnostics take precedence over live pre-crash warnings. */
export const cloudMemoryNotice = (
	statusCode: string,
	pressure: boolean,
	failureDiagnostic?: string,
): {
	readonly title: MessageKey;
	readonly busy: boolean;
} | null => {
	switch (
		failureDiagnostic?.startsWith("runtime-memory-")
			? failureDiagnostic
			: statusCode
	) {
		case "runtime-memory-pressure":
			return { title: "connections:cloud_memory_waiting", busy: true };
		case "runtime-memory-recovering":
			return { title: "connections:cloud_memory_recovering", busy: true };
		case "runtime-memory-recovery-failed":
			return { title: "connections:cloud_memory_failed", busy: false };
		default:
			return pressure
				? { title: "connections:cloud_memory_low", busy: false }
				: null;
	}
};

/** Watching an active connection must not create new demand for idle compute. */
export const shouldObserveCloudMemory = (
	summary: Pick<CloudChatSummary, "state" | "runtimeState"> | null,
	connection: ConnectionPhase,
	activity: CloudChatActivity,
): boolean =>
	summary?.state === "ready" &&
	summary.runtimeState === "online" &&
	connection === "connected" &&
	(activity === "running" ||
		activity === "starting-agent" ||
		activity === "stopping");
