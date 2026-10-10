import "@zuse/i18n/english/chat";
import type { ChatRef } from "@zuse/client-runtime/resource-ref";
import type { Session } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { ChevronDown, CornerUpLeft } from "lucide-react";
import { useState } from "react";
import type { DetachedSubagentGroup } from "../lib/group-messages.ts";
import { openSession } from "../lib/session-navigation.ts";
import { useUiStore } from "../store/ui.ts";
import { ProviderIcon } from "./provider-icons.tsx";
import { SubagentAvatar } from "./subagent-identity.tsx";

export function AgentsSummary({
	chatRef,
	session,
	sessions,
	nativeAgents,
}: {
	readonly chatRef: ChatRef;
	readonly session: Session;
	readonly sessions: ReadonlyArray<Session>;
	readonly nativeAgents: ReadonlyArray<DetachedSubagentGroup>;
}) {
	const { message } = useMessages(["chat"]);
	const [navigationFailed, setNavigationFailed] = useState(false);
	const revealSubagent = useUiStore((state) => state.revealSubagent);
	const children = sessions.filter(
		(candidate) => candidate.parentSessionId === session.id,
	);
	const parent = sessions.find(
		(candidate) => candidate.id === session.parentSessionId,
	);
	const navigate = async (target: Session["id"]) => {
		setNavigationFailed(false);
		try {
			setNavigationFailed(
				!(await openSession({
					environmentId: chatRef.environmentId,
					sessionId: target,
				})),
			);
		} catch {
			setNavigationFailed(true);
		}
	};
	const entries = [
		...children.map((child) => ({
			id: `session:${child.id}`,
			title: child.title,
			active: child.status === "running" || child.status === "booting",
			status:
				child.status === "booting"
					? message("chat:delegation_row_starting")
					: child.status === "running"
						? message("chat:delegation_status_running")
						: child.status === "error"
							? message("chat:delegation_status_failed")
							: message("chat:delegation_status_done"),
			icon: (
				<ProviderIcon
					providerId={child.providerId}
					className="size-3.5 shrink-0"
				/>
			),
			open: () => void navigate(child.id),
		})),
		...nativeAgents.map((child) => ({
			id: `native:${child.childSessionId}`,
			title: child.agentName,
			active: child.summary === null,
			status:
				child.summary === null
					? message("chat:delegation_status_running")
					: child.summary.isError
						? message("chat:delegation_status_failed")
						: message("chat:delegation_status_done"),
			icon: <SubagentAvatar name={child.agentName} size="sm" />,
			open: () => revealSubagent(chatRef, child.childSessionId),
		})),
	];
	if (entries.length === 0 && !session.parentSessionId) return null;
	const active = entries.filter((entry) => entry.active);
	const previous = entries.filter((entry) => !entry.active);
	const row = (entry: (typeof entries)[number]) => (
		<button
			key={entry.id}
			type="button"
			onClick={entry.open}
			title={entry.title}
			className="flex h-7 w-full items-center gap-2 rounded px-1.5 text-left text-xs hover:bg-muted/60 focus-visible:outline focus-visible:outline-1"
		>
			{entry.icon}
			<span className="min-w-0 flex-1 truncate">{entry.title}</span>
			<span className="shrink-0 text-[10px] text-muted-foreground">
				{entry.status}
			</span>
		</button>
	);
	return (
		<section
			aria-label={message("chat:agents_summary_title")}
			className="mx-2 mt-2 border-t border-border/60 pb-1 pt-2"
		>
			<h3 className="mb-1 flex items-center gap-2 px-1 text-xs font-medium">
				{message("chat:agents_summary_title")}
				{active.length > 0 ? (
					<span className="font-normal text-muted-foreground">
						{message("chat:agents_summary_running", {
							count: String(active.length),
						})}
					</span>
				) : null}
			</h3>
			{session.parentSessionId ? (
				<button
					type="button"
					onClick={() => {
						if (session.parentSessionId) void navigate(session.parentSessionId);
					}}
					className="mb-1 flex h-7 w-full items-center gap-2 rounded px-1.5 text-left text-xs hover:bg-muted/60 focus-visible:outline focus-visible:outline-1"
				>
					<CornerUpLeft className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="shrink-0 text-muted-foreground">
						{message("chat:agents_summary_parent")}
					</span>
					<span className="truncate">
						{parent?.title ?? message("chat:agents_summary_parent_chat")}
					</span>
				</button>
			) : null}
			{active.map(row)}
			{previous.length > 0 ? (
				<details className="group">
					<summary className="flex h-7 cursor-pointer list-none items-center gap-1 px-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
						{message("chat:agents_summary_previous", {
							count: String(previous.length),
						})}
						<ChevronDown className="ml-auto size-3 transition-transform group-open:rotate-180" />
					</summary>
					{previous.map(row)}
				</details>
			) : null}
			{navigationFailed ? (
				<p role="status" className="px-1 pt-1 text-xs text-muted-foreground">
					{message("chat:agents_summary_unavailable")}
				</p>
			) : null}
		</section>
	);
}
