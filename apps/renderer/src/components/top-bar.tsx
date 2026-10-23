import { openPathInTarget } from "../lib/open-path-in-target.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { CopyButton } from "./copy-button.tsx";
import { GitStackMenu } from "./git-stack-menu.tsx";
import { PreviewPortsMenu } from "./preview-ports-menu.tsx";
import { WorkspaceSharingButton } from "./workspace-sharing-button.tsx";
import "@zuse/i18n/english/projects";
import { isInputComposing } from "../lib/input-composition.ts";
import { CreateBranchDialog } from "./create-branch-dialog.tsx";
import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatRef, ExecutionRef } from "@zuse/client-runtime/resource-ref";
import {
	CommandId,
	EnvironmentId,
	type FolderId,
	type GitBranchInfo,
	type WorktreeId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Copy01Icon,
	GitBranchIcon,
	LinkSquare01Icon,
	Loading02Icon,
	Menu01Icon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	PanelRightCloseIcon,
	PanelRightOpenIcon,
	PencilEdit01Icon,
	Search01Icon,
	Tick01Icon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown, PanelBottom } from "lucide-react";
import {
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useState,
} from "react";
import { resolveBranchLabel } from "../lib/branch-workflow.ts";
import type { OpenTarget } from "../lib/bridge.ts";
import { cloudTopBarContext } from "../lib/cloud-top-bar-context.ts";
import {
	cloudSummaryForChat,
	useCloudChatCatalogStore,
} from "../lib/cloud-workspace-catalog.ts";
import {
	useActiveEnvironmentEntities,
	useEnvironmentChat,
} from "../lib/environment-entity-hooks.ts";
import {
	dispatchGitWorkspaceCommand,
	refreshGitWorkspace,
	useGitWorkspaceResource,
} from "../lib/git-workspace-client-bus.ts";
import { isMacHost } from "../lib/host-platform.ts";
import { rendererPlatformCapabilities } from "../lib/platform-capabilities.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { rightPaneKey, useUiStore } from "../store/ui.ts";
import { useWorktreesStore } from "../store/worktrees.ts";
import {
	CloudWorkspaceMenu,
	useIsCloudWorkspace,
} from "./cloud-workspace-info.tsx";
import { OpenTargetIcon } from "./open-target-icon.tsx";
import { TooltipShortcut } from "./projects-sidebar.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuShortcut,
	MenuTrigger,
} from "./ui/menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

const loadRenameDialog = () => import("./rename-dialog.tsx");
const RenameDialog = lazy(() =>
	loadRenameDialog().then((module) => ({ default: module.RenameDialog })),
);

const errorMessage = (err: unknown): string => {
	if (typeof err === "object" && err !== null && "reason" in err) {
		const reason = (err as { reason?: unknown }).reason;
		if (typeof reason === "string" && reason.length > 0) return reason;
	}
	if (err instanceof Error && err.message.length > 0) return err.message;
	return "Something went wrong.";
};

const SECTION_CLASS =
	"flex h-9 shrink-0 items-center gap-1 text-[11px] [-webkit-app-region:drag]";
const ACTION_CLASS = "[-webkit-app-region:no-drag]";
const ICON_BUTTON_CLASS = `${ACTION_CLASS} flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground`;
const NATIVE_CONTROLS_INSET_CLASS =
	"pr-[calc(var(--zuse-window-controls-right-inset)+0.25rem)]";

/** Shared with main-pane bars outside this file (e.g. the Zot header). */
export {
	ACTION_CLASS as TOP_BAR_ACTION_CLASS,
	ICON_BUTTON_CLASS as TOP_BAR_ICON_BUTTON_CLASS,
	NATIVE_CONTROLS_INSET_CLASS as TOP_BAR_NATIVE_CONTROLS_INSET_CLASS,
	SECTION_CLASS as TOP_BAR_SECTION_CLASS,
};

const executionRefFor = (
	context: ReturnType<typeof useActiveContext>,
): ExecutionRef | null =>
	context.status === "ready"
		? {
				environmentId: context.environmentId,
				folderId: context.folderId,
				worktreeId: context.worktreeId,
				rootPath: context.rootPath,
			}
		: null;

/**
 * Top bar over the projects panel: product name on the left + a left-pane
 * collapse toggle on the right. In windowed mode we leave 80px clear at
 * the start so the macOS traffic-light controls have room; in fullscreen
 * the controls are gone, so we hug the edge instead.
 */
export function TopBarLeft() {
	const { message: uiMessage } = useUiMessages(["chat", "projects", "common"]);

	const setLeftSidebarOpen = useUiStore((s) => s.setLeftSidebarOpen);
	const isFullScreen = useUiStore((s) => s.isFullScreen);
	const reserveMacTrafficLights = isMacHost() && !isFullScreen;

	return (
		<section
			aria-label={uiMessage("common:projects_controls")}
			className="shrink-0"
		>
			<div
				role="toolbar"
				aria-label={uiMessage("common:projects_toolbar")}
				className={`${SECTION_CLASS} pr-1 ${reserveMacTrafficLights ? "pl-20" : "pl-3"}`}
			>
				<span className="truncate font-semibold tracking-tight text-foreground">
					{uiMessage("chat:top_bar_zuse_beta")}
				</span>
				<span className="flex-1" />
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={() => setLeftSidebarOpen(false)}
								className={ICON_BUTTON_CLASS}
								aria-label={uiMessage("chat:top_bar_hide_projects_panel")}
							>
								<HugeiconsIcon icon={PanelLeftCloseIcon} className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						<TooltipShortcut
							label={uiMessage("common:hide_projects_panel")}
							shortcut={formatShortcut("toggle-left-sidebar")}
						/>
					</TooltipPopup>
				</Tooltip>
			</div>
		</section>
	);
}

/**
 * Top bar over the main pane. Holds the projects-panel open-toggle (only
 * when that panel is collapsed), the branch label, and the right-pane
 * open/close toggle (always visible — the user expects to find it here
 * regardless of which way the files panel is currently leaning).
 */
/**
 * Leading padding for a main-pane top bar: flush while the projects panel is
 * open; with it collapsed, room for the open-toggle and, in windowed macOS,
 * the traffic-light controls.
 */
export function useTopBarLeadingPad(): string {
	const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
	const isFullScreen = useUiStore((s) => s.isFullScreen);
	return !leftSidebarOpen && isMacHost() && !isFullScreen ? "pl-20" : "pl-2";
}

/** Projects-panel open-toggle shown in a main-pane top bar while it's collapsed. */
export function ShowProjectsPanelButton() {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
	const setLeftSidebarOpen = useUiStore((s) => s.setLeftSidebarOpen);
	if (leftSidebarOpen) return null;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={() => setLeftSidebarOpen(true)}
						className={ICON_BUTTON_CLASS}
						aria-label={uiMessage("chat:top_bar_show_projects_panel")}
					>
						<HugeiconsIcon icon={PanelLeftOpenIcon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup>
				<TooltipShortcut
					label={uiMessage("chat:top_bar_show_projects_panel")}
					shortcut={formatShortcut("toggle-left-sidebar")}
				/>
			</TooltipPopup>
		</Tooltip>
	);
}

export function TopBarMain() {
	const { message: uiMessage } = useUiMessages([
		"connections",
		"chat",
		"projects",
		"common",
	]);

	const ctx = useActiveContext();
	const executionRef = executionRefFor(ctx);
	const environmentId =
		executionRef?.environmentId ??
		(ctx.status === "worktree-pending"
			? ctx.environmentId
			: ctx.status === "cloud-unavailable"
				? EnvironmentId.make(ctx.workspaceId)
				: null);
	const folderId =
		ctx.status === "ready" || ctx.status === "worktree-pending"
			? ctx.folderId
			: null;
	const scratch = useWorkspaceStore((s) =>
		s.folders.some(
			(folder) => folder.id === folderId && folder.kind === "scratch",
		),
	);
	const worktreeId =
		ctx.status === "ready" || ctx.status === "worktree-pending"
			? ctx.worktreeId
			: null;
	const status =
		useGitWorkspaceResource(scratch ? null : executionRef, "connect").data
			?.status ?? null;
	const refreshWorktrees = useWorktreesStore((s) => s.refresh);
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const selectedChatRef: ChatRef | null =
		selectedChatId === null || environmentId === null
			? null
			: { environmentId, chatId: selectedChatId };
	const selectedChatKey =
		selectedChatRef === null ? null : rightPaneKey(selectedChatRef);
	const readOnly = useEnvironmentChat(selectedChatRef)?.readOnly === true;
	const registeredCloudSummaryCandidate =
		selectedChatId === null ? null : cloudSummaryForChat(selectedChatId);
	const registeredCloudSummary =
		registeredCloudSummaryCandidate?.workspaceId ===
		selectedChatRef?.environmentId
			? registeredCloudSummaryCandidate
			: null;
	const cloudSummary = useCloudChatCatalogStore((state) =>
		selectedChatRef === null
			? null
			: (state.summaries.find(
					(item) =>
						item.chatId === selectedChatRef.chatId &&
						item.workspaceId === selectedChatRef.environmentId,
				) ?? registeredCloudSummary),
	);
	const cachedCloudContext = cloudTopBarContext(cloudSummary);
	const origin = useActiveEnvironmentEntities().originsByFolder[folderId ?? ""];
	const originOwner = origin?.owner ?? cachedCloudContext?.owner ?? null;
	const rightSidebarOpen = useUiStore((s) =>
		selectedChatKey === null
			? false
			: (s.rightPaneLayoutByChat[selectedChatKey]?.open ?? false),
	);
	const setRightSidebarOpenForChat = useUiStore(
		(s) => s.setRightSidebarOpenForChat,
	);
	const bottomTerminalOpen = useUiStore((s) =>
		selectedChatKey === null
			? false
			: (s.bottomTerminalLayoutByChat[selectedChatKey]?.open ?? false),
	);
	const setBottomTerminalOpenForChat = useUiStore(
		(s) => s.setBottomTerminalOpenForChat,
	);
	const environmentSummaryOpen = useUiStore((s) => s.environmentSummaryOpen);
	const toggleEnvironmentSummary = useUiStore(
		(s) => s.toggleEnvironmentSummary,
	);

	const hasSession = useSessionsStore((s) => s.selectedSessionId !== null);
	const isCloudWorkspace = useIsCloudWorkspace(
		ctx.status === "ready" ? ctx.environmentId : null,
	);
	const [branches, setBranches] = useState<ReadonlyArray<GitBranchInfo>>([]);
	const [branchesLoading, setBranchesLoading] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [renameOpen, setRenameOpen] = useState(false);
	const projectedWorktreeBranch = useWorktreesStore((state) =>
		folderId === null || worktreeId === null
			? null
			: ((state.byProject[folderId] ?? []).find(
					(worktree) => worktree.id === worktreeId,
				)?.branch ?? null),
	);

	const resolvedBranch = resolveBranchLabel(
		status?.branch ?? null,
		projectedWorktreeBranch,
		cachedCloudContext?.branch ?? null,
	);
	const branchLabel = resolvedBranch.label;
	const branchIsCached = resolvedBranch.cached;
	const leftPad = useTopBarLeadingPad();

	const refreshBranches = async (): Promise<void> => {
		if (scratch || readOnly || executionRef === null || folderId === null)
			return;
		setBranchesLoading(true);
		setBranchError(null);
		try {
			const { result } = await dispatchGitWorkspaceCommand<
				{ readonly folderId: FolderId; readonly worktreeId: WorktreeId | null },
				ReadonlyArray<GitBranchInfo>
			>({
				ref: executionRef,
				kind: "git.branches",
				commandId: CommandId.make(`git-branches:${crypto.randomUUID()}`),
				payload: { folderId, worktreeId },
			});
			setBranches(result);
		} catch (err) {
			setBranchError(errorMessage(err));
		} finally {
			setBranchesLoading(false);
		}
	};

	useEffect(() => {
		void refreshBranches();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folderId, worktreeId, branchLabel, readOnly, scratch]);

	const switchToBranch = async (branch: GitBranchInfo): Promise<void> => {
		if (
			readOnly ||
			executionRef === null ||
			folderId === null ||
			branch.current
		)
			return;
		if (
			status !== null &&
			status.dirtyFiles > 0 &&
			!window.confirm(
				`Switch branches with ${status.dirtyFiles} uncommitted change${
					status.dirtyFiles === 1 ? "" : "s"
				}? Git may refuse if the changes conflict.`,
			)
		) {
			return;
		}
		setBranchesLoading(true);
		setBranchError(null);
		try {
			await dispatchGitWorkspaceCommand({
				ref: executionRef,
				kind: "git.switchBranch",
				commandId: CommandId.make(`git-switch:${crypto.randomUUID()}`),
				payload: {
					folderId,
					worktreeId,
					branch: branch.name,
					remote: branch.remote,
				},
			});
			void refreshGitWorkspace(executionRef);
			await refreshBranches();
		} catch (err) {
			setBranchError(errorMessage(err));
		} finally {
			setBranchesLoading(false);
		}
	};

	return (
		<div
			role="toolbar"
			aria-label={uiMessage("common:workspace_toolbar")}
			className={`${SECTION_CLASS} ${leftPad} bg-muted/20 ${rightSidebarOpen ? "pr-1" : NATIVE_CONTROLS_INSET_CLASS}`}
		>
			<ShowProjectsPanelButton />
			<div className={`flex min-w-0 flex-1 items-center ${ACTION_CLASS}`}>
				{hasSession && !scratch ? (
					<nav
						aria-label={uiMessage("chat:top_bar_branch_name")}
						className="flex min-w-0 max-w-[min(208px,100%)] items-center gap-1 text-[11px]"
					>
						{branchLabel ? (
							<>
								<Avatar className="size-3.5 shrink-0 rounded-sm">
									{originOwner !== null ? (
										<AvatarImage
											src={`https://github.com/${encodeURIComponent(originOwner)}.png?size=32`}
											alt=""
										/>
									) : null}
									<AvatarFallback className="rounded-sm bg-foreground/8 text-[8px] text-muted-foreground">
										{(
											originOwner ??
											cachedCloudContext?.repositoryLabel ??
											branchLabel
										)
											.slice(0, 1)
											.toUpperCase()}
									</AvatarFallback>
								</Avatar>
								{branchIsCached || isCloudWorkspace || readOnly ? (
									<span
										className="min-w-0 max-w-36 truncate px-1 text-muted-foreground"
										title={branchLabel}
									>
										{branchLabel}
									</span>
								) : (
									<BranchMenuButton
										showIcon={false}
										branchLabel={branchLabel}
										branches={branches}
										canRename={worktreeId !== null}
										className="min-w-0 max-w-36 [&>svg]:size-3 px-1 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground"
										dirtyFiles={status?.dirtyFiles ?? 0}
										error={branchError}
										loading={branchesLoading}
										onOpen={() => void refreshBranches()}
										onRename={() => {
											void loadRenameDialog();
											setRenameOpen(true);
										}}
										onSwitch={(branch) => void switchToBranch(branch)}
									/>
								)}
								<CopyButton
									text={branchLabel}
									label={uiMessage(
										"connections:cloud_workspace_menu_copy_branch",
									)}
									className="h-7 w-6 [&_svg]:size-3"
								/>
							</>
						) : null}
					</nav>
				) : null}
			</div>
			{!readOnly &&
			renameOpen &&
			executionRef !== null &&
			folderId !== null &&
			worktreeId !== null &&
			branchLabel !== null ? (
				<Suspense fallback={null}>
					<RenameBranchDialog
						executionRef={executionRef}
						branchLabel={branchLabel}
						open
						onOpenChange={setRenameOpen}
						onRenamed={async () => {
							if (executionRef !== null)
								await refreshGitWorkspace(executionRef);
							await refreshWorktrees(folderId);
							await refreshBranches();
						}}
						worktreeId={worktreeId}
					/>
				</Suspense>
			) : null}
			{selectedChatRef !== null && (
				<WorkspaceSharingButton
					key={selectedChatKey}
					chatRef={selectedChatRef}
				/>
			)}
			{hasSession && !readOnly ? (
				cloudSummary !== null ? (
					<div className="flex items-center gap-1">
						<PreviewPortsMenu environmentId={cloudSummary.workspaceId} />
						<CloudWorkspaceMenu
							workspaceId={cloudSummary.workspaceId}
							className={ACTION_CLASS}
						/>
					</div>
				) : (
					<OpenInMenu rootPath={ctx.status === "ready" ? ctx.rootPath : null} />
				)
			) : null}
			{hasSession && !scratch ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								onClick={toggleEnvironmentSummary}
								className={`${ICON_BUTTON_CLASS} ${
									environmentSummaryOpen
										? "bg-foreground/10 text-foreground"
										: ""
								}`}
								aria-label={uiMessage(
									"chat:top_bar_toggle_environment_summary",
								)}
								aria-pressed={environmentSummaryOpen}
							>
								<HugeiconsIcon icon={Menu01Icon} className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						{uiMessage("chat:top_bar_toggle_environment_summary")}
					</TooltipPopup>
				</Tooltip>
			) : null}
			{selectedChatRef !== null && ctx.status === "ready" ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								aria-label={uiMessage("common:toggle_bottom_terminal")}
								aria-pressed={bottomTerminalOpen}
								className={`${ICON_BUTTON_CLASS} ${bottomTerminalOpen ? "bg-foreground/10 text-foreground" : ""}`}
								onClick={() =>
									setBottomTerminalOpenForChat(
										selectedChatRef,
										!bottomTerminalOpen,
									)
								}
							>
								<PanelBottom className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						{uiMessage("common:toggle_bottom_terminal")}
					</TooltipPopup>
				</Tooltip>
			) : null}
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={() => {
								if (selectedChatRef !== null)
									setRightSidebarOpenForChat(
										selectedChatRef,
										!rightSidebarOpen,
									);
							}}
							className={ICON_BUTTON_CLASS}
							aria-label={
								rightSidebarOpen
									? uiMessage("chat:top_bar_hide_files_panel")
									: uiMessage("chat:top_bar_show_files_panel")
							}
						>
							{rightSidebarOpen ? (
								<HugeiconsIcon
									icon={PanelRightCloseIcon}
									className="size-3.5"
								/>
							) : (
								<HugeiconsIcon icon={PanelRightOpenIcon} className="size-3.5" />
							)}
						</button>
					}
				/>
				<TooltipPopup>
					<TooltipShortcut
						label={
							rightSidebarOpen
								? uiMessage("chat:top_bar_hide_files_panel")
								: uiMessage("chat:top_bar_show_files_panel")
						}
						shortcut={formatShortcut("toggle-right-sidebar")}
					/>
				</TooltipPopup>
			</Tooltip>
		</div>
	);
}

export function BranchMenuButton({
	showIcon = true,
	branchLabel,
	branches,
	canRename,
	className,
	popupSide = "bottom",
	dirtyFiles,
	error,
	loading,
	onOpen,
	onRename,
	onSwitch,
	variant = "toolbar",
}: {
	showIcon?: boolean;
	branchLabel: string;
	branches: ReadonlyArray<GitBranchInfo>;
	canRename: boolean;
	className?: string;
	popupSide?: "bottom" | "left";
	dirtyFiles: number;
	error: string | null;
	loading: boolean;
	onOpen: () => void;
	onRename: () => void;
	onSwitch: (branch: GitBranchInfo) => void;

	variant?: "toolbar" | "summary";
}) {
	const { message: uiMessage } = useUiMessages([
		"connections",
		"chat",
		"projects",
		"common",
	]);

	const executionRef = executionRefFor(useActiveContext());
	const [createFrom, setCreateFrom] = useState<"HEAD" | "origin/main" | null>(
		null,
	);
	const [branchQuery, setBranchQuery] = useState("");
	const normalizedQuery = branchQuery.trim().toLocaleLowerCase();
	const matchingBranches = branches.filter((branch) => {
		if (normalizedQuery.length === 0) return true;
		return [branch.name, branch.remote, branch.upstream].some((value) =>
			value?.toLocaleLowerCase().includes(normalizedQuery),
		);
	});
	const localBranches = matchingBranches.filter((b) => b.kind === "local");
	const remoteBranches = matchingBranches.filter((b) => b.kind === "remote");

	return (
		<>
			<Menu
				modal={popupSide !== "left"}
				onOpenChange={(open) => !open && setBranchQuery("")}
			>
				<MenuTrigger
					onClick={onOpen}
					className={`flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground outline-none hover:bg-foreground/5 data-[popup-open]:bg-foreground/5 ${className ?? "max-w-64"}`}
					aria-label={uiMessage("chat:top_bar_switch_branch")}
				>
					{showIcon ? (
						<HugeiconsIcon
							icon={GitBranchIcon}
							className={`${variant === "summary" ? "size-4" : "size-3.5"} shrink-0 text-muted-foreground`}
						/>
					) : null}
					<span
						className="min-w-0 flex-1 truncate text-left"
						title={branchLabel}
					>
						{branchLabel}
					</span>
					{variant === "toolbar" && dirtyFiles > 0 ? (
						<span className="shrink-0 text-muted-foreground">
							· {dirtyFiles}
						</span>
					) : null}
					{loading ? (
						<HugeiconsIcon
							icon={Loading02Icon}
							className="size-3 animate-spin text-muted-foreground"
						/>
					) : (
						<ChevronDown
							className={`size-3 shrink-0 text-muted-foreground ${variant === "summary" ? "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[popup-open]:opacity-100" : ""}`}
						/>
					)}
				</MenuTrigger>
				<MenuPopup
					side={popupSide}
					sideOffset={popupSide === "left" ? 8 : 4}
					align="start"
					className="w-72"
				>
					<div className="flex items-center gap-2 px-2 py-1">
						<span className="min-w-0 flex-1 select-text break-all text-xs">
							{branchLabel}
						</span>
						<CopyButton
							text={branchLabel}
							label={uiMessage("connections:cloud_workspace_menu_copy_branch")}
							className="h-7 w-7"
						/>
					</div>
					<MenuSeparator />
					{error !== null ? (
						<div className="max-w-72 px-2 py-1.5 text-[11px] leading-snug text-[var(--accent-red)]">
							{error}
						</div>
					) : null}
					{canRename ? (
						<>
							<MenuItem
								onClick={onRename}
								className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
							>
								<HugeiconsIcon icon={PencilEdit01Icon} className="size-3.5" />
								{uiMessage("chat:top_bar_rename_current_branch")}
							</MenuItem>
							<MenuSeparator />
						</>
					) : null}
					<div className="sticky top-0 z-10 bg-glass px-1 pb-1">
						<label className="flex h-7 items-center gap-1.5 rounded-md px-2">
							<HugeiconsIcon
								icon={Search01Icon}
								className="size-3.5 shrink-0 text-muted-foreground"
							/>
							<span className="sr-only">
								{uiMessage("chat:top_bar_search_branches")}
							</span>
							<input
								type="search"
								value={branchQuery}
								onChange={(event) => setBranchQuery(event.target.value)}
								onKeyDown={(event) => {
									if (isInputComposing(event)) return;

									if (event.key !== "Escape") event.stopPropagation();
								}}
								placeholder={uiMessage("chat:top_bar_search_branches")}
								className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
							/>
						</label>
					</div>
					<div className="max-h-56 overflow-y-auto overscroll-contain">
						<MenuSectionLabel>
							{uiMessage("chat:top_bar_local_branches")}
						</MenuSectionLabel>
						{localBranches.length > 0 ? (
							localBranches.map((branch) => (
								<MenuItem
									key={`local:${branch.name}`}
									disabled={branch.current || loading}
									onClick={() => onSwitch(branch)}
									className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
								>
									<HugeiconsIcon
										icon={Tick01Icon}
										className={`size-3.5 ${branch.current ? "opacity-100" : "opacity-0"}`}
									/>
									<span className="min-w-0 flex-1 truncate">{branch.name}</span>
									{branch.upstream !== null ? (
										<span className="max-w-28 truncate text-[10px] text-muted-foreground">
											{branch.upstream}
										</span>
									) : null}
								</MenuItem>
							))
						) : normalizedQuery.length === 0 ? (
							<div className="px-2 py-1.5 text-xs text-muted-foreground">
								{uiMessage("chat:top_bar_no_local_branches")}
							</div>
						) : null}
						{remoteBranches.length > 0 ? (
							<>
								<MenuSeparator />
								<MenuSectionLabel>
									{uiMessage("chat:top_bar_remote_branches")}
								</MenuSectionLabel>
								{remoteBranches.map((branch) => (
									<MenuItem
										key={`remote:${branch.remote ?? branch.name}`}
										disabled={loading}
										onClick={() => onSwitch(branch)}
										className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-sidebar-accent"
									>
										<HugeiconsIcon icon={GitBranchIcon} className="size-3.5" />
										<span className="min-w-0 flex-1 truncate">
											{branch.name}
										</span>
										{branch.remote !== null ? (
											<span className="max-w-28 truncate text-[10px] text-muted-foreground">
												{branch.remote}
											</span>
										) : null}
									</MenuItem>
								))}
							</>
						) : null}
						{matchingBranches.length === 0 ? (
							<div className="px-2 py-5 text-center text-xs text-muted-foreground">
								{uiMessage("chat:top_bar_no_matching_branches")}
							</div>
						) : null}
					</div>
					<MenuSeparator />
					<MenuItem
						disabled={loading || executionRef === null}
						onClick={() => setCreateFrom("HEAD")}
					>
						{uiMessage("projects:github_new_branch")}
					</MenuItem>
					<MenuItem
						disabled={loading || executionRef === null || dirtyFiles > 0}
						onClick={() => setCreateFrom("origin/main")}
					>
						{uiMessage("projects:github_new_origin_branch")}
					</MenuItem>
					{executionRef && (
						<GitStackMenu
							executionRef={executionRef}
							branch={branchLabel}
							variant="submenu"
						/>
					)}
				</MenuPopup>
			</Menu>
			{executionRef && createFrom ? (
				<CreateBranchDialog
					executionRef={executionRef}
					base={createFrom}
					onClose={() => {
						setCreateFrom(null);
						onOpen();
					}}
				/>
			) : null}
		</>
	);
}

function MenuSectionLabel({ children }: { children: ReactNode }) {
	return (
		<div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
			{children}
		</div>
	);
}

function RenameBranchDialog({
	branchLabel,
	executionRef,
	open,
	onOpenChange,
	onRenamed,
	worktreeId,
}: {
	branchLabel: string;
	executionRef: ExecutionRef;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRenamed: () => Promise<void>;
	worktreeId: WorktreeId;
}) {
	const { message: uiMessage } = useUiMessages([
		"connections",
		"chat",
		"projects",
		"common",
	]);

	const rename = async (next: string) => {
		await dispatchGitWorkspaceCommand({
			ref: executionRef,
			kind: "worktree.renameBranch",
			commandId: CommandId.make(`worktree-rename:${crypto.randomUUID()}`),
			payload: { worktreeId, name: next },
		});
		await onRenamed();
	};

	return (
		<RenameDialog
			title={uiMessage("chat:top_bar_rename_branch")}
			description={uiMessage(
				"chat:top_bar_rename_the_unpublished_branch_for_this_chat_workspace",
			)}
			label={uiMessage("chat:top_bar_branch_name")}
			value={branchLabel}
			open={open}
			onOpenChange={onOpenChange}
			onRename={rename}
		/>
	);
}

function OpenInMenu({ rootPath }: { rootPath: string | null }) {
	const { message: uiMessage } = useUiMessages([
		"connections",
		"chat",
		"projects",
		"common",
	]);

	const capabilities = rendererPlatformCapabilities();
	const [targets, setTargets] = useState<ReadonlyArray<OpenTarget>>([]);
	const [loading, setLoading] = useState(false);
	const availableTargets = useMemo(
		() => targets.filter((target) => target.available),
		[targets, uiMessage],
	);
	const primary = availableTargets.find((target) => target.id === "finder");

	const refreshTargets = async (): Promise<void> => {
		if (rootPath === null) return;
		const bridge = window.zuse?.app;
		if (bridge?.listOpenTargets === undefined) return;
		setLoading(true);
		try {
			setTargets(await bridge.listOpenTargets(rootPath));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void refreshTargets();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rootPath]);

	const openTarget = async (target: OpenTarget): Promise<void> => {
		if (rootPath === null) return;
		await openPathInTarget(rootPath, target.id);
	};

	const copyPath = async (): Promise<void> => {
		if (rootPath === null) return;
		await window.zuse?.app?.copyPath?.(rootPath);
	};

	if (!capabilities.openInEditor && !capabilities.revealInFileManager) {
		return null;
	}

	return (
		<Menu>
			<Tooltip>
				<TooltipTrigger
					render={
						<MenuTrigger
							disabled={rootPath === null}
							onClick={() => void refreshTargets()}
							className={`${ACTION_CLASS} flex h-7 items-center overflow-hidden rounded-md border border-border/80 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50`}
							aria-label={uiMessage("chat:top_bar_open_workspace_in_app")}
						>
							<span className="flex size-7 items-center justify-center border-r border-border/80">
								{loading ? (
									<HugeiconsIcon
										icon={Loading02Icon}
										className="size-3.5 animate-spin"
									/>
								) : primary !== undefined ? (
									<OpenTargetIcon target={primary} />
								) : (
									<HugeiconsIcon icon={LinkSquare01Icon} className="size-3.5" />
								)}
							</span>
							<span className="flex size-7 items-center justify-center">
								<ChevronDown className="size-3.5" />
							</span>
						</MenuTrigger>
					}
				/>
				<TooltipPopup>{uiMessage("chat:top_bar_open_in")}</TooltipPopup>
			</Tooltip>
			<MenuPopup align="end" className="min-w-56">
				{availableTargets.map((target, index) => (
					<MenuItem
						key={target.id}
						onClick={() => void openTarget(target)}
						className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
					>
						<OpenTargetIcon target={target} />
						<span className="min-w-0 flex-1 truncate">{target.label}</span>
						<MenuShortcut>{index + 1}</MenuShortcut>
					</MenuItem>
				))}
				<MenuSeparator />
				<MenuItem
					onClick={() => void copyPath()}
					className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
				>
					<HugeiconsIcon icon={Copy01Icon} className="size-4" />
					<span className="min-w-0 flex-1 truncate">
						{uiMessage("chat:top_bar_copy_path")}
					</span>
					<MenuShortcut>⌘⇧C</MenuShortcut>
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}
