import { runningBackgroundTasks } from "@zuse/client-runtime/background-agent-presentation";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type { ProviderId, SessionTimelineProjection } from "@zuse/contracts";
import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import { useMessages } from "@zuse/i18n/react";
import { useMemo, useState } from "react";
import { formatElapsed } from "../lib/delegation-display.ts";
import { formatError } from "../lib/format-error.ts";
import { stopBackgroundTask } from "../lib/session-actions.ts";
import { useRelativeTimeTick } from "../lib/use-relative-time.ts";
import { trayPillTextActionClass } from "./composer/tray-pill.tsx";

/** Task controls displayed inside the environment summary. */
export function BackgroundTasks({
	view,
	sessionRef,
	providerId,
}: {
	readonly view: ResourceView<SessionTimelineProjection>;
	readonly sessionRef: SessionRef;
	readonly providerId: ProviderId;
}) {
	const { message } = useMessages(["chat", "common"]);
	const tasks = useMemo(() => runningBackgroundTasks(view), [view]);
	const now = useRelativeTimeTick(1_000);
	const [errors, setErrors] = useState<Readonly<Record<string, string | null>>>(
		{},
	);
	if (tasks.length === 0) return null;
	return (
		<section
			aria-label={message("chat:background_tasks_title")}
			className="min-w-0 py-1"
		>
			{tasks.map((task) => {
				const pending = view.pendingCommands.some(
					(command) =>
						command.kind === "messages.background.stop" &&
						command.targetId === task.taskId,
				);
				const failed = view.failedCommands.find(
					(command) =>
						command.kind === "messages.background.stop" &&
						command.targetId === task.taskId,
				);
				const errorKey = `${sessionRef.environmentId}:${sessionRef.sessionId}:${task.attemptId}:${task.id}`;
				const error = pending
					? null
					: errorKey in errors
						? errors[errorKey]
						: failed?.error;
				const canStop =
					providerId === "claude" &&
					task.turnId !== null &&
					task.attemptId !== null &&
					view.data?.activeTurn?.id === task.turnId &&
					view.data.activeTurn.attempt?.id === task.attemptId;
				const label =
					task.description ||
					message(
						task.kind === "process"
							? "chat:background_process"
							: "chat:background_agent",
					);
				const kindLabel = message(
					task.kind === "process"
						? "chat:background_process"
						: "chat:background_agent",
				);
				const indicator = (
					<span
						aria-hidden="true"
						className="size-1.5 shrink-0 rounded-full bg-lime-500"
					/>
				);
				const timer = (
					<span
						role="timer"
						aria-live="off"
						className="shrink-0 font-mono tabular-nums text-muted-foreground"
					>
						{formatElapsed(Math.max(0, now - task.startedAtMs))}
					</span>
				);
				const stop = canStop ? (
					<button
						type="button"
						className={trayPillTextActionClass}
						disabled={pending}
						aria-label={message("chat:background_stop_task", { task: label })}
						onClick={() => {
							setErrors((current) => ({ ...current, [errorKey]: null }));
							void stopBackgroundTask(sessionRef, task).catch((cause) => {
								setErrors((current) => ({
									...current,
									[errorKey]: formatError(cause),
								}));
							});
						}}
					>
						{message(pending ? "chat:chat_composer_stopping" : "common:stop")}
					</button>
				) : null;
				const failure = error ? (
					<p role="status" className="px-3 pb-1 text-xs text-destructive">
						{error}
					</p>
				) : null;
				return (
					<div key={task.id}>
						<div className="flex h-7 min-w-0 items-center gap-2 px-3 text-xs text-muted-foreground">
							{indicator}
							<span className="min-w-0 flex-1 truncate" title={label}>
								{label}
							</span>
							<span className="shrink-0 text-[10px] text-muted-foreground/70">
								{kindLabel}
							</span>
							{timer}
							{stop}
						</div>
						{failure}
					</div>
				);
			})}
		</section>
	);
}
