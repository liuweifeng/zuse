import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	CommandId,
	EnvironmentId,
	FolderId,
	GitBranchInfo,
	GitIssueSummary,
	GitPrSummary,
	Worktree,
	WorktreeId,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	GitBranchIcon,
	GitPullRequestIcon,
	RecordIcon,
	Search01Icon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { overlaySurface } from "~/components/ui/overlay-surface";
import { PopoverPrimitive } from "~/components/ui/popover";
import { dispatchEnvironmentShellCommand } from "~/lib/environment-shell-client-bus.ts";
import { dispatchGitWorkspaceCommand } from "~/lib/git-workspace-client-bus.ts";
import { cn } from "~/lib/utils";

/**
 * What the "Create from…" picker hands back to the Chat Lander. PRs + branches
 * carry `existingWorktreeId` when a worktree is already checked out on that
 * branch ("In use") so the lander can reuse it instead of a second checkout.
 * Issues have no branch — they turn into an attached `.md` + a prefilled prompt.
 */
export type CreateFromSelection =
	| {
			readonly kind: "pr";
			readonly number: number;
			readonly headRefName: string;
			readonly isCrossRepository: boolean;
			readonly title: string;
			readonly existingWorktreeId: WorktreeId | null;
	  }
	| {
			readonly kind: "branch";
			readonly branch: string;
			readonly remote: string | null;
			readonly existingWorktreeId: WorktreeId | null;
	  }
	| {
			readonly kind: "issue";
			readonly number: number;
			readonly title: string;
	  };

type Tab = "prs" | "branches" | "issues";

interface Row {
	readonly key: string;
	readonly icon: typeof GitPullRequestIcon;
	readonly lead: string;
	readonly label: string;
	readonly inUse: boolean;
	readonly selection: CreateFromSelection;
	readonly haystack: string;
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
	{
		id: "prs",
		get label() {
			return uiMessage("chat:create_from_menu_prs");
		},
	},
	{
		id: "branches",
		get label() {
			return uiMessage("chat:create_from_menu_branches");
		},
	},
	{
		id: "issues",
		get label() {
			return uiMessage("chat:create_from_menu_issues");
		},
	},
];

export interface CreateFromMenuProps {
	readonly environmentId: EnvironmentId;
	readonly folderId: FolderId | null;
	readonly rootPath: string;
	readonly onSelect: (selection: CreateFromSelection) => void;
}

/**
 * The "Create from…" control shown in the draft composer's header. Opens a
 * searchable, tabbed popover (PRs / Branches / Issues) sourced from `gh` +
 * `git`. Selecting a row reports it up to the Chat Lander, which starts the
 * chat against that PR/branch (checkout) or issue (attach + prefill).
 */
export function CreateFromMenu({
	environmentId,
	folderId,
	rootPath,
	onSelect,
}: CreateFromMenuProps) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<Tab>("prs");
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);

	const [prs, setPrs] = useState<ReadonlyArray<GitPrSummary> | null>(null);
	const [branches, setBranches] = useState<ReadonlyArray<GitBranchInfo> | null>(
		null,
	);
	const [issues, setIssues] = useState<ReadonlyArray<GitIssueSummary> | null>(
		null,
	);
	const [worktreesLoadedForOpen, setWorktreesLoadedForOpen] = useState(false);

	const [worktreeByBranch, setWorktreeByBranch] = useState<
		ReadonlyMap<string, WorktreeId>
	>(new Map());

	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		setPrs(null);
		setBranches(null);
		setIssues(null);
		setWorktreeByBranch(new Map());
		setWorktreesLoadedForOpen(false);
	}, [folderId]);

	useEffect(() => {
		if (!open) {
			setWorktreesLoadedForOpen(false);
			setQuery("");
		}
	}, [open]);

	useEffect(() => {
		if (!open || folderId === null) return;
		let cancelled = false;
		void (async () => {
			try {
				if (!worktreesLoadedForOpen) {
					const wts = await dispatchEnvironmentShellCommand<
						{ readonly projectId: FolderId },
						ReadonlyArray<Worktree>
					>({
						environmentId,
						kind: "worktree.list",
						commandId: crypto.randomUUID() as CommandId,
						payload: { projectId: folderId },
					})
						.then(({ result }) => result)
						.catch(() => []);
					if (cancelled) return;
					const map = new Map<string, WorktreeId>();
					for (const wt of wts) map.set(wt.branch, wt.id);
					setWorktreeByBranch(map);
					setWorktreesLoadedForOpen(true);
				}
				const ref = {
					environmentId,
					folderId,
					worktreeId: null,
					rootPath,
				} as const;
				if (tab === "prs" && prs === null) {
					const rows = await dispatchGitWorkspaceCommand<
						{ readonly folderId: FolderId },
						ReadonlyArray<GitPrSummary>
					>({
						ref,
						kind: "git.listPrs",
						commandId: crypto.randomUUID() as CommandId,
						payload: { folderId },
					})
						.then(({ result }) => result)
						.catch(() => []);
					if (!cancelled) setPrs(rows);
				} else if (tab === "branches" && branches === null) {
					const rows = await dispatchGitWorkspaceCommand<
						{ readonly folderId: FolderId },
						ReadonlyArray<GitBranchInfo>
					>({
						ref,
						kind: "git.branches",
						commandId: crypto.randomUUID() as CommandId,
						payload: { folderId },
					})
						.then(({ result }) => result)
						.catch(() => []);
					if (!cancelled) setBranches(rows);
				} else if (tab === "issues" && issues === null) {
					const rows = await dispatchGitWorkspaceCommand<
						{ readonly folderId: FolderId },
						ReadonlyArray<GitIssueSummary>
					>({
						ref,
						kind: "git.listIssues",
						commandId: crypto.randomUUID() as CommandId,
						payload: { folderId },
					})
						.then(({ result }) => result)
						.catch(() => []);
					if (!cancelled) setIssues(rows);
				}
			} catch {}
		})();
		return () => {
			cancelled = true;
		};
	}, [
		environmentId,
		open,
		tab,
		folderId,
		rootPath,
		prs,
		branches,
		issues,
		worktreesLoadedForOpen,
	]);

	const loading =
		(tab === "prs" && prs === null) ||
		(tab === "branches" && branches === null) ||
		(tab === "issues" && issues === null);

	const rows = useMemo<ReadonlyArray<Row>>(() => {
		if (tab === "prs") {
			return (prs ?? []).map((pr) => {
				const existing = worktreeByBranch.get(pr.headRefName) ?? null;
				return {
					key: `pr:${pr.number}`,
					icon: GitPullRequestIcon,
					lead: `#${pr.number}`,
					label: pr.title,
					inUse: existing !== null,
					selection: {
						kind: "pr",
						number: pr.number,
						headRefName: pr.headRefName,
						isCrossRepository: pr.isCrossRepository,
						title: pr.title,
						existingWorktreeId: existing,
					},
					haystack: `${pr.number} ${pr.title} ${pr.author} ${pr.headRefName}`,
				};
			});
		}
		if (tab === "branches") {
			return (branches ?? [])
				.filter((b) => !b.current)
				.map((b) => {
					const existing = worktreeByBranch.get(b.name) ?? null;
					return {
						key: `br:${b.kind}:${b.name}`,
						icon: GitBranchIcon,
						lead: "",
						label: b.name,
						inUse: existing !== null,
						selection: {
							kind: "branch",
							branch: b.name,
							remote:
								b.kind === "remote" && b.remote !== null
									? (b.remote.split("/")[0] ?? null)
									: null,
							existingWorktreeId: existing,
						},
						haystack: b.name,
					};
				});
		}
		return (issues ?? []).map((issue) => ({
			key: `is:${issue.number}`,
			icon: RecordIcon,
			lead: `#${issue.number}`,
			label: issue.title,
			inUse: false,
			selection: { kind: "issue", number: issue.number, title: issue.title },
			haystack: `${issue.number} ${issue.title} ${issue.author}`,
		}));
	}, [tab, prs, branches, issues, worktreeByBranch, uiMessage]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (q.length === 0) return rows;
		return rows.filter((r) => r.haystack.toLowerCase().includes(q));
	}, [rows, query]);

	useEffect(() => setHighlight(0), [filtered]);

	const confirm = (row: Row) => {
		onSelect(row.selection);
		setOpen(false);
		setQuery("");
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (filtered.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlight((h) => (h + 1) % filtered.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const row = filtered[highlight];
			if (row !== undefined) confirm(row);
		}
	};

	return (
		<PopoverPrimitive.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					requestAnimationFrame(() => inputRef.current?.focus());
				}
			}}
		>
			<PopoverPrimitive.Trigger
				className={cn(
					"flex h-7 items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2.5 text-[11px] text-foreground transition-colors",
					"hover:bg-accent data-[popup-open]:bg-accent",
					folderId === null && "pointer-events-none opacity-50",
				)}
				aria-label={uiMessage(
					"chat:create_from_menu_create_from_an_existing_pr_branch_or_issue_tracker_ticket",
				)}
			>
				<HugeiconsIcon
					icon={GitPullRequestIcon}
					className="size-3.5 text-muted-foreground"
				/>
				<span>{uiMessage("chat:create_from_menu_create_from")}</span>
				<ChevronDown className="size-3 opacity-60" />
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					className="z-50"
				>
					<PopoverPrimitive.Popup
						className={cn(
							"flex w-[30rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden outline-none",
							overlaySurface,
						)}
						onKeyDown={onKeyDown}
					>
						<div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
							<HugeiconsIcon
								icon={Search01Icon}
								className="size-4 shrink-0 text-muted-foreground"
							/>
							<input
								ref={inputRef}
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={
									tab === "branches"
										? uiMessage("chat:create_from_menu_search_by_name")
										: uiMessage(
												"chat:create_from_menu_search_by_title_number_or_author",
											)
								}
								className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
							/>
						</div>
						<div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
							{TABS.map((t) => (
								<button
									key={t.id}
									type="button"
									onClick={() => {
										setTab(t.id);
										inputRef.current?.focus();
									}}
									className={cn(
										"rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
										tab === t.id
											? "bg-accent text-accent-foreground"
											: "text-muted-foreground hover:bg-muted hover:text-foreground",
									)}
								>
									{t.label}
								</button>
							))}
						</div>
						<div className="max-h-80 min-h-24 overflow-y-auto py-1">
							{loading ? (
								<div className="px-3 py-6 text-center text-sm text-muted-foreground">
									{uiMessage("common:loading")}
								</div>
							) : filtered.length === 0 ? (
								<div className="px-3 py-6 text-center text-sm text-muted-foreground">
									{tab === "branches"
										? uiMessage("chat:create_from_menu_no_other_branches")
										: uiMessage("chat:create_from_menu_no_found", {
												value1: String(
													tab === "prs" ? "open PRs" : "open issues",
												),
											})}
								</div>
							) : (
								filtered.map((row, i) => {
									const active = i === highlight;
									return (
										<button
											key={row.key}
											type="button"
											role="option"
											aria-selected={active}
											onMouseEnter={() => setHighlight(i)}
											onClick={() => confirm(row)}
											className={cn(
												"flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
												active ? "bg-accent" : "hover:bg-muted",
											)}
										>
											<HugeiconsIcon
												icon={row.icon}
												className="size-4 shrink-0 text-muted-foreground"
											/>
											{row.lead.length > 0 && (
												<span className="shrink-0 font-mono text-xs text-muted-foreground">
													{row.lead}
												</span>
											)}
											<span className="min-w-0 flex-1 truncate text-sm text-foreground">
												{row.label}
											</span>
											<span className="shrink-0 text-xs text-muted-foreground">
												{row.inUse
													? uiMessage("chat:create_from_menu_in_use")
													: active
														? uiMessage("chat:create_from_menu_select")
														: ""}
											</span>
										</button>
									);
								})
							)}
						</div>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}
