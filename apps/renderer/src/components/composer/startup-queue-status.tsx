import "@zuse/i18n/english/chat";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { ComposerInput } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	startupQueueKey,
	useStartupQueueStore,
} from "../../composer/startup-queue.ts";
import { TrayPill, trayPillTextActionClass } from "./tray-pill.tsx";

export function StartupQueueStatus({
	sessionRef,
	queueId,
	input,
	creating,
}: {
	readonly sessionRef: SessionRef;
	readonly queueId: string;
	readonly input: ComposerInput;
	readonly creating: boolean;
}) {
	const { message } = useUiMessages(["chat", "common"]);
	const job = useStartupQueueStore(
		(state) => state.jobs[startupQueueKey(sessionRef, queueId)],
	);
	const preparing =
		job?.status === "preparing" || (job === undefined && creating);
	// A message queued during a turn is briefly unready while it is saved.
	// Without uploaded files there is nothing to reattach: not a failure.
	if (job === undefined && !creating && input.attachments.length === 0)
		return null;
	return (
		<TrayPill
			flush
			tone={preparing ? "default" : "danger"}
			role={preparing ? "status" : "alert"}
			title={
				preparing
					? message("chat:startup_queue_preparing")
					: message("chat:startup_queue_failed")
			}
			expanded={
				!preparing ? (
					<div className="px-3 pb-2 text-[11px] text-muted-foreground">
						{job?.error ?? message("chat:startup_queue_reattach")}
					</div>
				) : undefined
			}
			actions={
				job?.status === "failed" ? (
					<button
						type="button"
						className={trayPillTextActionClass}
						onClick={() => void job.retry()}
					>
						{message("common:retry")}
					</button>
				) : undefined
			}
		/>
	);
}
