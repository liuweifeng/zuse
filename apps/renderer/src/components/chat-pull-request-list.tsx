import "@zuse/i18n/english/common";
import "@zuse/i18n/english/projects";
import { useMessages } from "@zuse/i18n/react";
import { useState } from "react";
import type { ChatPullRequest } from "../lib/chat-pull-requests.ts";
import { openHttpLink } from "../lib/http-links.ts";
import { cn } from "../lib/utils.ts";
import { PrStateIcon } from "./branch-icon.tsx";

/**
 * A chat's linked pull requests as one chain: state glyphs joined by a thin
 * rail, `#N`, and the title. The chat's own PR is the bright row. Rows open
 * the PR on GitHub unless the list is display-only (e.g. inside a tooltip).
 */
export function ChatPullRequestList({
	pullRequests,
	limit = Number.POSITIVE_INFINITY,
	density = "summary",
	interactive = true,
}: {
	readonly pullRequests: ReadonlyArray<ChatPullRequest>;
	/** Rows shown before the rest fold behind "Show N more". */
	readonly limit?: number;
	readonly density?: "summary" | "compact";
	readonly interactive?: boolean;
}) {
	const { message } = useMessages(["projects", "common"]);
	const [expanded, setExpanded] = useState(false);
	const visible = expanded ? pullRequests : pullRequests.slice(0, limit);
	const hidden = interactive ? pullRequests.length - visible.length : 0;
	const compact = density === "compact";
	const rowClass = cn(
		"flex w-full min-w-0 items-center gap-2 rounded-md pe-2 text-left text-xs outline-none",
		compact ? "h-6 ps-1" : "h-7 ps-2.5",
	);
	const row = (pr: ChatPullRequest) => (
		<>
			<span className="grid size-4 shrink-0 place-items-center">
				<PrStateIcon pr={pr} className="size-3.5" />
			</span>
			<span
				className={cn(
					"min-w-0 flex-1 truncate",
					pr.isCurrent ? "text-foreground" : "text-muted-foreground",
				)}
			>
				{pr.title ??
					message("projects:github_pr_number", { number: pr.number })}
			</span>
			<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
				#{pr.number}
			</span>
		</>
	);
	return (
		<ul className="flex flex-col">
			{visible.map((pr, index) => (
				<li key={pr.number} className="relative">
					{index < visible.length - 1 ? (
						<span
							aria-hidden="true"
							className={cn(
								"absolute top-1/2 w-px translate-y-[9px] bg-muted-foreground/30",
								compact ? "start-[11.5px] h-1.5" : "start-[17.5px] h-2.5",
							)}
						/>
					) : null}
					{interactive ? (
						<button
							type="button"
							disabled={pr.url === null}
							onClick={() => {
								if (pr.url !== null) void openHttpLink(pr.url);
							}}
							title={pr.title ?? undefined}
							className={cn(
								rowClass,
								"hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:hover:bg-transparent",
							)}
						>
							{row(pr)}
						</button>
					) : (
						<div className={rowClass}>{row(pr)}</div>
					)}
				</li>
			))}
			{hidden > 0 ? (
				<li>
					<button
						type="button"
						onClick={() => setExpanded(true)}
						className={cn(
							"flex h-6 w-full items-center rounded-md text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
							compact ? "ps-7" : "ps-[34px]",
						)}
					>
						{message("common:show_more_count", {
							count: String(hidden),
						})}
					</button>
				</li>
			) : null}
		</ul>
	);
}
