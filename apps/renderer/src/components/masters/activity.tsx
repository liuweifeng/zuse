import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages } from "@zuse/i18n/react";
import { Tick02Icon } from "@zuse/icons/solid-rounded";
import type { MasterWorkerActivity } from "../../lib/master-activity.ts";
import { AgentActivityOrb } from "../ui/agent-activity-orb.tsx";

const ACTIVITY_LABEL = {
	working: "projects:masters_working",
	blocked: "projects:masters_needs_attention",
	offline: "projects:masters_offline",
	idle: "projects:masters_idle",
	paused: "projects:masters_worker_paused",
	done: "projects:masters_worker_done",
} as const satisfies Record<MasterWorkerActivity, string>;

const ACTIVITY_DOT: Record<
	Exclude<MasterWorkerActivity, "working" | "done">,
	string
> = {
	blocked: "bg-amber-400",
	paused: "bg-amber-400/70",
	offline: "border border-muted-foreground/60",
	idle: "bg-muted-foreground/40",
};

/** Fixed `size-5` slot so rows align regardless of state. */
export function MasterActivityIcon({
	activity,
}: {
	readonly activity: MasterWorkerActivity;
}) {
	const { message } = useMessages("projects");
	const label = message(ACTIVITY_LABEL[activity]);
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			className="inline-grid size-5 shrink-0 place-items-center"
		>
			{activity === "working" ? (
				<AgentActivityOrb state="working" />
			) : activity === "done" ? (
				<HugeiconsIcon
					icon={Tick02Icon}
					strokeWidth={2.5}
					className="size-3.5 text-emerald-400"
				/>
			) : (
				<span className={`size-1.5 rounded-full ${ACTIVITY_DOT[activity]}`} />
			)}
		</span>
	);
}
