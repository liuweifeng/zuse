import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatCreationPhase } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { Alert01Icon, Tick01Icon } from "@zuse/icons/solid-rounded";
import { ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useWorktreeSetupLifecycle } from "../hooks/use-worktree-setup-lifecycle.ts";
import type { ActivityLoaderScene } from "../lib/activity-loader-scenes.ts";
import { useCloudChatCatalogStore } from "../lib/cloud-workspace-catalog.ts";
import { formatElapsed } from "../lib/delegation-display.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { shouldShowSetupCard } from "../lib/setup-card-visibility.ts";
import { useRelativeTimeTick } from "../lib/use-relative-time.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { useWorktreesStore } from "../store/worktrees.ts";
import { ActivityLoader } from "./ui/activity-loader.tsx";
import { Button } from "./ui/button.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

type StepState = "pending" | "active" | "done" | "failed";

/**
 * Everything the unified setup card needs to render, decoupled from the
 * stores so the same markup can drive both the live in-`ChatView` card and
 * the optimistic landing bridge (no session/worktree row yet). Keeping it a
 * plain prop object guarantees the two render pixel-identically so the swap
 * from bridge → live card is invisible.
 */
export type SetupCardData = {
	/** Repo / project name — "a new copy of <repo>". */
	readonly repoName: string;
	readonly creationPhase?: ChatCreationPhase | null;
	/** Whether this flow creates a worktree at all (false = main checkout). */
	readonly hasWorktree: boolean;
	/** Worktree row not hydrated yet — branch/copy still in flight. */
	readonly worktreePending: boolean;
	readonly worktreeName: string | null;
	readonly branch: string | null;
	readonly baseBranch: string | null;
	/** `null` until the worktree row exists. */
	readonly setupStatus:
		| "pending"
		| "running"
		| "succeeded"
		| "failed"
		| "skipped"
		| null;
	readonly setupOutput: string;
	/** Rerun handler, present only when setup has failed and a row exists. */
	readonly onRerun: (() => void) | null;
	/** Epoch ms the creation began; defaults to when the card mounted. */
	readonly startedAt?: number | null;
};

/**
 * Inline timeline card shown while a new chat is coming up: it narrates the
 * worktree branch/copy, streams the live environment-setup log, and tracks
 * the provider/model CLI boot — all in one place, with the composer pinned
 * at the bottom. Replaces the old full-screen `ChatCreatingPanel` stepper.
 * Renders nothing once there's no setup work left and the provider is ready.
 */
export function WorktreeSetupCard({
	providerOutputStarted = false,
}: {
	readonly providerOutputStarted?: boolean;
} = {}) {
	const ctx = useActiveContext();
	const selectedChatId = useChatsStore((state) => state.selectedChatId);
	const pendingCreation = useChatsStore((state) =>
		selectedChatId === null
			? null
			: (state.pendingCreationByChat[selectedChatId] ?? null),
	);
	const cloudSummary = useCloudChatCatalogStore(
		(state) =>
			state.summaries.find((row) => row.chatId === selectedChatId) ?? null,
	);
	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const { sessionsByProject, creationOperationsByProject } =
		useActiveEnvironmentEntities();
	const creation = Object.values(creationOperationsByProject)
		.flat()
		.find((row) => row.chatId === selectedChatId);
	const creationPhase = creation?.phase ?? pendingCreation?.phase ?? null;
	const session =
		selectedSessionId === null
			? null
			: (Object.values(sessionsByProject)
					.flat()
					.find((candidate) => candidate.id === selectedSessionId) ?? null);
	const initialSession = (() => {
		if (session === null) return false;
		const chatSessions = sessionsByProject[session.projectId] ?? [];
		const oldest = chatSessions
			.filter((candidate) => candidate.chatId === session.chatId)
			.toSorted(
				(left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
			)[0];
		return oldest?.id === session.id;
	})();
	const repoName = useWorkspaceStore((s) => {
		if (ctx.status !== "ready" && ctx.status !== "worktree-pending")
			return null;
		return s.folders.find((f) => f.id === ctx.folderId)?.name ?? null;
	});
	const setupProjectId =
		pendingCreation?.projectId ??
		(ctx.status === "ready" || ctx.status === "worktree-pending"
			? ctx.folderId
			: null);
	const setupWorktreeId =
		ctx.status === "ready" || ctx.status === "worktree-pending"
			? ctx.worktreeId
			: (creation?.worktreeId ?? pendingCreation?.worktreeId ?? null);
	const worktree = useWorktreeSetupLifecycle(
		setupProjectId,
		setupWorktreeId,
		creationPhase,
	);
	const rerunSetup = useWorktreesStore((s) => s.rerunSetup);
	const hasWorktree =
		ctx.status === "worktree-pending" ||
		(ctx.status === "ready" && ctx.worktreeId !== null);
	const worktreePending =
		ctx.status === "worktree-pending" ||
		(ctx.status === "ready" && ctx.worktreePending);
	const setupStatus = worktree?.setupStatus ?? null;
	const setupDone =
		setupStatus === "succeeded" ||
		setupStatus === "skipped" ||
		((setupStatus === null || setupStatus === "pending") &&
			(creationPhase === "starting_agent" || creationPhase === "running"));
	const externalResume = session !== null && session.resumeStrategy !== "none";

	// This card owns workspace setup only. As soon as that work is done, the
	// normal transcript activity row owns provider startup.
	const visible = shouldShowSetupCard({
		externalResume,
		initialSession,
		hasWorktree,
		setupDone,
		workspacePending: ctx.status === "worktree-pending",
	});
	if (providerOutputStarted) return null;
	// Cloud lifecycle is shown once, in the composer connection tray.
	if (cloudSummary !== null) return null;
	if (!visible) return null;

	return (
		<SetupCardView
			data={{
				repoName: repoName ?? "this repo",
				creationPhase,
				hasWorktree,
				worktreePending,
				worktreeName: worktree?.name ?? null,
				branch: worktree?.branch ?? null,
				baseBranch: worktree?.baseBranch ?? null,
				setupStatus,
				setupOutput: worktree?.setupOutput ?? "",
				startedAt: creation?.createdAt.getTime() ?? null,
				onRerun:
					worktree !== null && setupStatus === "failed"
						? () => void rerunSetup(worktree.projectId, worktree.id)
						: null,
			}}
		/>
	);
}

/**
 * Presentational card. Pure function of {@link SetupCardData} so the live
 * card and the landing bridge share one source of truth for the markup.
 * Mirrors `ChatWorkingRow` (loader, muted label, elapsed time) so the handoff
 * from workspace setup to provider startup reads as one continuous row.
 */
export function SetupCardView({ data }: { data: SetupCardData }) {
	const { message: uiMessage } = useUiMessages(["common", "projects"]);

	const {
		repoName,
		hasWorktree,
		worktreePending,
		worktreeName,
		branch,
		baseBranch,
		creationPhase,
		setupStatus: observedSetupStatus,
		setupOutput,
		onRerun,
	} = data;

	const setupStatus =
		observedSetupStatus !== null && observedSetupStatus !== "pending"
			? observedSetupStatus
			: creationPhase === "starting_agent" || creationPhase === "running"
				? "succeeded"
				: creationPhase === "running_setup"
					? "running"
					: creationPhase === "failed"
						? "failed"
						: observedSetupStatus;
	const showsWorktreeSteps = hasWorktree || worktreePending;
	const wtReady =
		showsWorktreeSteps &&
		(!worktreePending ||
			setupStatus === "running" ||
			setupStatus === "succeeded" ||
			setupStatus === "skipped");
	const setupDone = setupStatus === "succeeded" || setupStatus === "skipped";
	const failed = setupStatus === "failed";
	const summaryState: StepState = failed
		? "failed"
		: !setupDone
			? "active"
			: "done";
	const summaryLabel = failed
		? wtReady
			? uiMessage("projects:worktree_setup_card_environment_setup_failed")
			: uiMessage("projects:worktree_setup_card_worktree_creation_failed")
		: setupStatus === "running"
			? uiMessage("projects:worktree_setup_card_running_environment_setup")
			: setupDone
				? uiMessage("projects:worktree_setup_card_workspace_ready")
				: !wtReady
					? uiMessage("projects:worktree_setup_card_creating_worktree", {
							repoName,
						})
					: uiMessage("projects:worktree_setup_card_detecting_setup_script");

	const worktreeStep: { state: StepState; label: string } = !wtReady
		? failed
			? {
					state: "failed",
					label: uiMessage(
						"projects:worktree_setup_card_worktree_creation_failed",
					),
				}
			: {
					state: "active",
					label: uiMessage(
						"projects:worktree_setup_card_branching_a_fresh_worktree",
					),
				}
		: {
				state: "done",
				label:
					branch !== null && baseBranch !== null
						? uiMessage("projects:worktree_setup_card_branched_from", {
								branch,
								value2: baseBranch,
							})
						: worktreeName !== null
							? uiMessage(
									"projects:worktree_setup_card_created_a_new_copy_of_called",
									{ repoName, name: worktreeName },
								)
							: uiMessage("projects:worktree_setup_card_workspace_ready"),
			};
	const environmentStep: { state: StepState; label: string } = !wtReady
		? {
				state: "pending",
				label: uiMessage("projects:worktree_setup_card_detecting_setup_script"),
			}
		: failed
			? {
					state: "failed",
					label: uiMessage(
						"projects:worktree_setup_card_environment_setup_failed",
					),
				}
			: setupStatus === "skipped"
				? {
						state: "done",
						label: uiMessage("projects:worktree_setup_card_no_setup_script"),
					}
				: setupStatus === "succeeded"
					? {
							state: "done",
							label: uiMessage(
								"projects:worktree_setup_card_environment_setup_complete",
							),
						}
					: setupStatus === "running"
						? {
								state: "active",
								label: uiMessage(
									"projects:worktree_setup_card_running_environment_setup",
								),
							}
						: {
								state: "active",
								label: uiMessage(
									"projects:worktree_setup_card_detecting_setup_script",
								),
							};

	const [mountedAt] = useState(() => Date.now());
	const now = useRelativeTimeTick(1_000);
	const elapsed = Math.max(0, now - (data.startedAt ?? mountedAt));
	const output = setupOutput.trim();
	const outputRef = useRef<HTMLPreElement>(null);
	// Follow the live log tail unless the user scrolled up to read it.
	useLayoutEffect(() => {
		const element = outputRef.current;
		if (element === null) return;
		const distance =
			element.scrollHeight - element.scrollTop - element.clientHeight;
		if (distance < 48) element.scrollTop = element.scrollHeight;
	}, [output]);

	return (
		<details
			className="group/setup w-full px-4 py-1 text-[11px]"
			// Failures need the log and the rerun action without an extra click.
			open={failed || undefined}
		>
			<summary className="flex h-7 cursor-pointer list-none items-center gap-2 rounded-md text-muted-foreground outline-none select-none marker:content-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
				<span
					className="flex size-4 shrink-0 items-center justify-center"
					aria-hidden="true"
				>
					<SetupStepIcon
						state={summaryState}
						scene={setupStatus === "running" ? "donut" : "helix"}
						size={16}
					/>
				</span>
				<span
					className={
						summaryState === "failed"
							? "min-w-0 truncate text-destructive"
							: "min-w-0 truncate"
					}
				>
					{summaryLabel}
				</span>
				{branch !== null ? (
					<span
						title={branch}
						className="min-w-0 max-w-[40%] truncate font-mono text-muted-foreground/70"
					>
						{branch}
					</span>
				) : null}
				{summaryState === "active" ? (
					<ShimmerText tone="lime" className="shrink-0 tabular-nums">
						{formatElapsed(elapsed)}
					</ShimmerText>
				) : null}
				<ChevronRight
					aria-hidden="true"
					className="size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/setup:rotate-90 motion-reduce:transition-none"
				/>
			</summary>
			<div className="flex flex-col gap-1.5 pb-1 pl-6 pt-0.5">
				{showsWorktreeSteps ? (
					<ol className="flex flex-col">
						<SetupStepRow {...worktreeStep} scene="helix" />
						<SetupStepRow {...environmentStep} scene="donut" />
					</ol>
				) : null}
				{output.length > 0 ? (
					<pre
						ref={outputRef}
						className="max-h-48 overflow-auto rounded-md bg-muted/30 px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-muted-foreground"
					>
						{output}
					</pre>
				) : null}
				{onRerun !== null ? (
					<div>
						<Button
							variant="ghost"
							className="-ml-2 h-7 px-2"
							onClick={onRerun}
						>
							{uiMessage("projects:worktree_setup_card_rerun_setup")}
						</Button>
					</div>
				) : null}
			</div>
		</details>
	);
}

function SetupStepIcon({
	state,
	scene,
	size,
}: {
	readonly state: StepState;
	readonly scene: ActivityLoaderScene;
	readonly size: number;
}) {
	if (state === "active") return <ActivityLoader scene={scene} size={size} />;
	if (state === "pending")
		return <span className="size-1.5 rounded-full bg-muted-foreground/40" />;
	return (
		<HugeiconsIcon
			icon={state === "failed" ? Alert01Icon : Tick01Icon}
			className={state === "failed" ? "size-3.5 text-destructive" : "size-3.5"}
		/>
	);
}

function SetupStepRow({
	state,
	label,
	scene,
}: {
	readonly state: StepState;
	readonly label: string;
	readonly scene: ActivityLoaderScene;
}) {
	return (
		<li className="flex h-6 min-w-0 items-center gap-2">
			<span
				className="flex size-3.5 shrink-0 items-center justify-center"
				aria-hidden="true"
			>
				<SetupStepIcon state={state} scene={scene} size={12} />
			</span>
			<span
				className={
					state === "failed"
						? "min-w-0 truncate text-destructive"
						: state === "pending"
							? "min-w-0 truncate text-muted-foreground/60"
							: state === "active"
								? "min-w-0 truncate text-foreground/80"
								: "min-w-0 truncate text-muted-foreground"
				}
			>
				{label}
			</span>
		</li>
	);
}
