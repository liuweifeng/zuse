import "@zuse/i18n/english/projects";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type {
	MasterAction,
	MasterArtifact,
	MasterSnapshot,
	MasterWorker,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	BrowserIcon,
	File01Icon,
	PlayIcon,
	StopIcon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import {
	type MasterWorkerActivity,
	masterWorkerActivity,
} from "../../lib/master-activity.ts";
import {
	canControlWorker,
	masterCapabilities,
} from "../../lib/master-capabilities.ts";
import { useEnvironmentLabel } from "../../store/environment-catalog.ts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";
import { MasterActivityIcon } from "./activity.tsx";

const ACTIVITY_ORDER: Record<MasterWorkerActivity, number> = {
	blocked: 0,
	working: 1,
	idle: 2,
	offline: 3,
	paused: 4,
	done: 5,
};

/** Supervised slaves, most urgent first. */
const rankedSlaves = (snapshot: MasterSnapshot) =>
	snapshot.master.workers
		.map((worker) => ({
			worker,
			activity: masterWorkerActivity(worker, snapshot.chats),
		}))
		.sort(
			(left, right) =>
				ACTIVITY_ORDER[left.activity] - ACTIVITY_ORDER[right.activity],
		);

export function SlaveList({
	snapshot,
	busy,
	perform,
	openChat,
}: {
	readonly snapshot: MasterSnapshot;
	readonly busy: boolean;
	readonly perform: (action: MasterAction) => void;
	readonly openChat: (
		environmentId: string,
		chatId: string,
		sessionId: string,
	) => void;
}) {
	const { message } = useMessages("projects");
	const master = snapshot.master;
	const workers = rankedSlaves(snapshot);
	const capabilities = masterCapabilities(snapshot);
	const showEnvironment =
		new Set(master.repositories.map((repo) => repo.environmentId)).size > 1;
	return (
		<div>
			{snapshot.pendingActions.map((pending) => (
				<p
					key={pending.commandId}
					className="truncate px-2 pb-1 text-[11px] text-muted-foreground"
				>
					{message("projects:masters_pending_action", {
						kind: pending.kind,
						state: pending.state,
					})}
				</p>
			))}
			{workers.length === 0 ? (
				<p className="px-2 py-1 text-[11px] leading-4 text-muted-foreground">
					{message(
						"projects:masters_ask_the_master_to_start_work_it_will_decide_which_tasks_need_separate_agents",
					)}
				</p>
			) : (
				<ul className="flex flex-col gap-0.5">
					{workers.map(({ worker, activity }) => (
						<WorkerRow
							key={`${worker.environmentId}:${worker.sessionId}`}
							worker={worker}
							activity={activity}
							showEnvironment={showEnvironment}
							controllable={canControlWorker(
								worker,
								master.homeEnvironmentId,
								capabilities,
							)}
							repository={
								master.repositories.find(
									(repository) =>
										repository.environmentId === worker.environmentId &&
										repository.folderId === worker.folderId,
								)?.name ?? null
							}
							busy={busy}
							perform={perform}
							onOpen={() =>
								openChat(worker.environmentId, worker.chatId, worker.sessionId)
							}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

export function PinnedArtifacts({
	artifacts,
	openArtifact,
}: {
	readonly artifacts: readonly MasterArtifact[];
	readonly openArtifact: (artifact: MasterArtifact) => void;
}) {
	return (
		<ul className="flex flex-col gap-0.5">
			{artifacts.map((artifact) => (
				<li key={artifact.id}>
					<button
						type="button"
						onClick={() => openArtifact(artifact)}
						className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						<HugeiconsIcon
							icon={artifact.kind === "screen" ? BrowserIcon : File01Icon}
							className="size-3.5 shrink-0"
						/>
						<span className="min-w-0 flex-1 truncate">{artifact.title}</span>
						<span className="shrink-0 tabular-nums text-[10px]">
							v{artifact.version}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

function WorkerRow({
	worker,
	activity,
	showEnvironment,
	controllable,
	repository,
	busy,
	perform,
	onOpen,
}: {
	readonly worker: MasterWorker;
	readonly activity: MasterWorkerActivity;
	readonly showEnvironment: boolean;
	/** False for a slave outside the home when cross-environment control is off. */
	readonly controllable: boolean;
	readonly repository: string | null;
	readonly busy: boolean;
	readonly perform: (action: MasterAction) => void;
	readonly onOpen: () => void;
}) {
	const { message } = useMessages("projects");
	const environment =
		useEnvironmentLabel(worker.environmentId) ??
		message("projects:masters_this_environment");
	const target = {
		environmentId: worker.environmentId,
		sessionId: worker.sessionId,
	};
	return (
		<li
			className={`group relative flex items-start gap-1.5 rounded-md py-1.5 pr-1.5 pl-1 text-[12px] transition-colors hover:bg-sidebar-accent/40 ${activity === "done" ? "opacity-60" : ""}`}
		>
			<button
				type="button"
				aria-label={`${message("projects:masters_open_chat")}: ${worker.objective}`}
				onClick={onOpen}
				className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<span className="pointer-events-none mt-px">
				<MasterActivityIcon activity={activity} />
			</span>
			<span className="pointer-events-none min-w-0 flex-1">
				<span className="line-clamp-2 leading-snug text-foreground">
					{worker.objective}
				</span>
				<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
					{[repository, showEnvironment ? environment : null]
						.filter(Boolean)
						.join(" · ")}
				</span>
			</span>
			{controllable ? (
				<span className="relative z-10 hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
					{activity === "paused" ? (
						<RowAction
							label={message("projects:masters_resume")}
							icon={PlayIcon}
							disabled={busy}
							onClick={() =>
								perform({ _tag: "worker", ...target, state: "active" })
							}
						/>
					) : activity !== "done" ? (
						<RowAction
							label={message("projects:masters_stop_agent")}
							icon={StopIcon}
							disabled={busy}
							onClick={() => perform({ _tag: "interrupt", ...target })}
						/>
					) : null}
					{activity !== "done" ? (
						<RowAction
							label={message("projects:masters_mark_done")}
							icon={Tick02Icon}
							disabled={busy}
							onClick={() =>
								perform({ _tag: "worker", ...target, state: "done" })
							}
						/>
					) : null}
				</span>
			) : null}
		</li>
	);
}

function RowAction({
	label,
	icon,
	disabled,
	onClick,
}: {
	readonly label: string;
	readonly icon: IconSvgElement;
	readonly disabled: boolean;
	readonly onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={label}
						disabled={disabled}
						onClick={onClick}
						className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
					>
						<HugeiconsIcon icon={icon} className="size-3.5" />
					</button>
				}
			/>
			<TooltipPopup>{label}</TooltipPopup>
		</Tooltip>
	);
}
