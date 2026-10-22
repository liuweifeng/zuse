import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Master } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Cancel01Icon } from "@zuse/icons/solid-rounded";
import { lazy, Suspense, useEffect, useState } from "react";
import { formatError } from "../../lib/format-error.ts";
import { formatRelativeTime } from "../../lib/use-relative-time.ts";
import { masterCommand } from "../../store/masters.ts";
import { Button } from "../ui/button.tsx";
import { ShimmerText } from "../ui/shimmer-text.tsx";

const MarkdownBody = lazy(() =>
	import("../markdown-body.tsx").then((module) => ({
		default: module.MarkdownBody,
	})),
);

type Transcript =
	| { status: "loading" }
	| { status: "ready"; content: string }
	| { status: "failed"; error: string };

/** Read-only list of the Master's coordinator conversations, newest first. */
export function MasterHistory({
	master,
	environmentId,
	onClose,
}: {
	readonly master: Master;
	readonly environmentId: string;
	readonly onClose: () => void;
}) {
	const { message } = useMessages("projects");
	const conversations = master.conversations
		.map((conversation, index) => ({ conversation, number: index + 1 }))
		.reverse();
	const [sessionId, setSessionId] = useState<string | null>(
		conversations.find(
			({ conversation }) => conversation.sessionId !== master.activeSessionId,
		)?.conversation.sessionId ?? null,
	);
	const [transcript, setTranscript] = useState<Transcript | null>(null);
	useEffect(() => {
		if (!sessionId) {
			setTranscript(null);
			return;
		}
		let disposed = false;
		setTranscript({ status: "loading" });
		masterCommand<{ masterId: string; sessionId: string }, { content: string }>(
			environmentId,
			"masters.transcript",
			{ masterId: master.id, sessionId },
		)
			.then(({ content }) => {
				if (!disposed) setTranscript({ status: "ready", content });
			})
			.catch((cause) => {
				if (!disposed)
					setTranscript({ status: "failed", error: formatError(cause) });
			});
		return () => {
			disposed = true;
		};
	}, [environmentId, master.id, sessionId]);

	return (
		<div className="flex min-h-0 flex-1">
			<nav
				aria-label={message("projects:masters_previous_conversations")}
				className="flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/50 p-1.5"
			>
				<div className="flex items-center justify-between py-0.5 pr-0.5 pl-2 text-[12px] text-muted-foreground">
					<h2 className="font-normal">
						{message("projects:masters_previous_conversations")}
					</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={message("projects:masters_close")}
						onClick={onClose}
					>
						<HugeiconsIcon icon={Cancel01Icon} />
					</Button>
				</div>
				{conversations.map(({ conversation, number }) => {
					const selected = conversation.sessionId === sessionId;
					return (
						<button
							type="button"
							key={conversation.sessionId}
							aria-current={selected ? "page" : undefined}
							onClick={() => setSessionId(conversation.sessionId)}
							className={`flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"}`}
						>
							<span className="min-w-0 flex-1 truncate">
								{message("projects:masters_conversation_number", { number })}
							</span>
							<span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
								{conversation.sessionId === master.activeSessionId
									? message("projects:masters_current")
									: formatRelativeTime(conversation.createdAt)}
							</span>
						</button>
					);
				})}
			</nav>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-3xl px-6 py-5">
					{transcript === null ? (
						<p className="text-sm text-muted-foreground">
							{message(
								"projects:masters_earlier_conversations_remain_readable_only_the_current_conversation_coordinates_work",
							)}
						</p>
					) : transcript.status === "loading" ? (
						<ShimmerText className="text-xs">
							{message("projects:masters_loading")}
						</ShimmerText>
					) : transcript.status === "failed" ? (
						<p role="alert" className="text-xs text-destructive">
							{transcript.error}
						</p>
					) : (
						<Suspense fallback={null}>
							<MarkdownBody>{transcript.content}</MarkdownBody>
						</Suspense>
					)}
				</div>
			</div>
		</div>
	);
}
