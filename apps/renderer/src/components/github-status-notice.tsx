import "@zuse/i18n/english/projects";
import "@zuse/i18n/english/common";
import "@zuse/i18n/english/chat";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type { GitPrInfo } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { gitHubStatusMessageKey } from "../lib/git-pr-state.ts";
import { refreshGitPrStatus } from "../lib/git-workspace-client-bus.ts";
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "./ui/popover.tsx";

/** Keep freshness quiet; explanations and recovery live behind one shared control. */
export function GitHubStatusNotice({
	pr,
	executionRef,
	compact = false,
}: {
	pr: GitPrInfo | null;
	executionRef: ExecutionRef | null;
	compact?: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const { message } = useMessages(["projects", "common", "chat"]);
	const key = gitHubStatusMessageKey(pr);
	const label = key ? message(key) : null;
	const retryAtMs = pr?.retryAt?.getTime() ?? 0;
	const [, setClock] = useState(0);
	useEffect(() => {
		const remaining = retryAtMs - Date.now();
		if (remaining <= 0) return;
		const timer = setTimeout(() => setClock((tick) => tick + 1), remaining);
		return () => clearTimeout(timer);
	}, [retryAtMs]);
	if (!label) return null;
	const waiting = retryAtMs > Date.now();
	const loading = key === "projects:github_observation_loading" || busy;
	const Icon = loading ? RefreshCw : CircleAlert;
	return (
		<Popover>
			<PopoverTrigger
				aria-label={label}
				title={label}
				className={`flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground ${compact ? "w-7" : "px-1.5"}`}
			>
				<Icon
					aria-hidden="true"
					className={`size-3.5 ${loading ? "animate-spin" : ""}`}
				/>
				{compact ? null : message("chat:review_annotation_github")}
			</PopoverTrigger>
			<PopoverPopup align="end" className="w-64">
				<div className="flex flex-col gap-2 px-1">
					<PopoverTitle className="text-xs font-medium">{label}</PopoverTitle>
					{pr?.observationError ? (
						<PopoverDescription className="break-words leading-relaxed">
							{pr.observationError}
						</PopoverDescription>
					) : null}
					{pr?.stale &&
					pr.state !== "none" &&
					key !== "projects:github_observation_offline" &&
					key !== "projects:github_observation_timeout" &&
					key !== "projects:github_observation_cached" ? (
						<p className="text-[11px] text-muted-foreground">
							{message("projects:github_observation_cached")}
						</p>
					) : null}
					<button
						type="button"
						className="flex h-7 items-center justify-center gap-1.5 rounded-md bg-muted/50 px-2 text-[11px] hover:bg-muted disabled:opacity-50"
						disabled={!executionRef || busy || waiting}
						onClick={() => {
							if (!executionRef) return;
							setBusy(true);
							void refreshGitPrStatus(executionRef)
								.catch(() => undefined)
								.finally(() => setBusy(false));
						}}
					>
						<RefreshCw
							aria-hidden="true"
							className={`size-3 ${busy ? "animate-spin" : ""}`}
						/>
						{busy
							? message("projects:github_observation_refreshing")
							: message("common:refresh")}
					</button>
				</div>
			</PopoverPopup>
		</Popover>
	);
}
