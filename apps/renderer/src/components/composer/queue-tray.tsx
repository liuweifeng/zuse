import {
	useCloudMessageQueue,
	useCloudQueueStatus,
} from "../../lib/cloud-message-queue.ts";
import { CloudMailboxQueue } from "./cloud-mailbox-queue.tsx";
import "@zuse/i18n/english/chat";
import type {
	CloudChatSummary,
	EnvironmentId,
	SessionId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useState } from "react";
import { useEnvironmentEntities } from "../../lib/environment-entity-hooks.ts";
import { usePlatformOnline } from "../../lib/network-status.ts";
import {
	canResumeQueue,
	holdQueueUntilOnline,
	queueHoldReason,
} from "../../lib/queue-recovery.ts";
import {
	reorderSessionQueue,
	resumeSessionQueue,
} from "../../lib/session-actions.ts";
import { isSessionTurnActive } from "../../lib/session-runtime-state.ts";
import { useRendererSessionTimeline } from "../../lib/session-timeline-hooks.ts";
import { useAutoAnimate } from "../../lib/use-auto-animate.ts";
import { QueueChip } from "./queue-chip.tsx";
import { TrayPill } from "./tray-pill.tsx";

export function QueueTray({
	sessionId,
	environmentId,
	cloudSummary = null,
	waitingForSandbox = false,
	creationInProgress = false,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	readonly cloudSummary?: CloudChatSummary | null;
	readonly waitingForSandbox?: boolean;
	readonly creationInProgress?: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const timeline = useRendererSessionTimeline(
		sessionId,
		"connect",
		environmentId,
	);
	const items = timeline.projection?.queue.items ?? [];
	const paused = timeline.projection?.queue.paused === true;
	const running = isSessionTurnActive(timeline.runtime);
	const { creationOperationsByProject } = useEnvironmentEntities(environmentId);
	const creation = Object.values(creationOperationsByProject)
		.flat()
		.find((operation) => operation.initialSessionId === sessionId);
	// Startup deliberately pauses the queue until the workspace is ready. The
	// durable operation survives navigation and reconnects; the local optimistic
	// creation entry does not always exist when this tray first renders.
	const preparing = creation
		? creation.phase !== "running" &&
			creation.phase !== "failed" &&
			creation.phase !== "cancelled"
		: creationInProgress;
	const ref = { environmentId, sessionId };
	const [dragIndex, setDragIndex] = useState<number | null>(null);

	const listRef = useAutoAnimate<HTMLDivElement>();
	const holdReason = queueHoldReason({ paused, runtime: timeline.runtime });
	const resumable = canResumeQueue({
		itemCount: items.length,
		paused,
		runtime: timeline.runtime,
		creationInProgress: preparing,
		waitingForSandbox,
	});

	const online = usePlatformOnline();
	useEffect(() => {
		if (!online && resumable)
			holdQueueUntilOnline({ environmentId, sessionId });
	}, [online, resumable, environmentId, sessionId]);
	const mailbox = useCloudMessageQueue(timeline);
	const cloudStatus = useCloudQueueStatus(cloudSummary, timeline);
	const mailboxQueue = (
		<CloudMailboxQueue
			messages={mailbox.waiting}
			commands={timeline.view.pendingCommands}
			status={cloudStatus}
		/>
	);
	if (items.length === 0) return mailboxQueue;

	const move = (from: number, to: number) => {
		if (from === to || to < 0 || to >= items.length) return;
		const next = [...items];
		const [item] = next.splice(from, 1);
		if (item === undefined) return;
		next.splice(to, 0, item);
		reorderSessionQueue(
			ref,
			next.map((q) => q.id),
		);
	};

	const showHeldPill = holdReason !== null && !running && !preparing;

	return (
		<div ref={listRef}>
			{mailboxQueue}
			<div className="border-b border-border/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
				{waitingForSandbox && mailbox.waiting.length === 0
					? cloudStatus.label
					: online
						? preparing
							? uiMessage("chat:queue_chip_starting")
							: uiMessage("chat:queue_tray_queued")
						: uiMessage("chat:queue_tray_waiting_for_connection")}
			</div>
			{showHeldPill ? (
				<TrayPill
					flush
					title={
						holdReason === "paused"
							? uiMessage("chat:queue_tray_queue_paused")
							: uiMessage(
									"chat:queue_tray_queue_held_because_the_last_turn_failed",
								)
					}
					actions={
						<button
							type="button"
							onClick={() => void resumeSessionQueue(ref)}
							className="rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:text-foreground"
							aria-label={uiMessage("chat:queue_tray_resume_queued_messages")}
						>
							{uiMessage("chat:queue_tray_resume")}
						</button>
					}
				/>
			) : null}
			{items.map((item, index) => (
				<QueueChip
					key={item.id}
					sessionId={sessionId}
					environmentId={environmentId}
					item={item}
					index={index}
					count={items.length}
					running={running}
					dragging={dragIndex === index}
					onMove={move}
					onDragStart={() => setDragIndex(index)}
					onDragOver={() => {
						if (dragIndex !== null && dragIndex !== index) {
							move(dragIndex, index);
							setDragIndex(index);
						}
					}}
					onDrop={() => setDragIndex(null)}
				/>
			))}
		</div>
	);
}
