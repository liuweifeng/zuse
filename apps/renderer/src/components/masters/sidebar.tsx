import "@zuse/i18n/english/projects";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Master } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { Add01Icon } from "@zuse/icons/solid-rounded";
import { useEffect, useState } from "react";
import { formatError } from "../../lib/format-error.ts";
import { activeSlaveCount } from "../../lib/master-activity.ts";
import { useMasterDirectory } from "../../lib/masters-client-bus.ts";
import {
	useEnvironmentCatalogStore,
	withConnectedEnvironments,
} from "../../store/environment-catalog.ts";
import { quickCreateMaster, useMastersStore } from "../../store/masters.ts";
import { SidebarActionRow } from "../sidebar-action-row.tsx";
import { toastManager } from "../ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";
import { avatarFor, Mascot, randomAvatar } from "./mascot.tsx";

function MasterDirectoryObserver({ environmentId }: { environmentId: string }) {
	const resource = useMasterDirectory(environmentId);
	useEffect(() => {
		const masters = resource.data;
		if (!masters) return;
		useMastersStore.setState((state) => ({
			masters: [
				...state.masters.filter(
					(master) => master.homeEnvironmentId !== environmentId,
				),
				...masters,
			],
		}));
	}, [environmentId, resource.data]);
	return null;
}

export function MastersSidebar() {
	const { message } = useMessages("projects");
	const masters = useMastersStore((state) => state.masters);
	const selection = useMastersStore((state) => state.selection);
	const environmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId,
	);
	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const environments = withConnectedEnvironments(entries, environmentId);
	// Only Zots whose home is still reachable; a disconnected environment's
	// directory stream stops updating, so its entries would go stale.
	const visible = masters
		.filter((master) => environments.includes(master.homeEnvironmentId))
		.toSorted((left, right) => right.createdAt - left.createdAt);
	const [creating, setCreating] = useState(false);
	const create = () => {
		if (creating) return;
		setCreating(true);
		void quickCreateMaster(environmentId, randomAvatar())
			.then((master) => {
				if (master === null)
					toastManager.add({
						type: "error",
						title: message("projects:masters_create_failed"),
						description: message("projects:masters_no_signed_in_agent"),
					});
			})
			.catch((cause) =>
				toastManager.add({
					type: "error",
					title: message("projects:masters_create_failed"),
					description: formatError(cause),
				}),
			)
			.finally(() => setCreating(false));
	};
	return (
		<section aria-label={message("projects:masters_masters")}>
			{environments.map((id) => (
				<MasterDirectoryObserver key={id} environmentId={id} />
			))}
			<div className="flex items-center justify-between px-2.5 py-1.5 text-[12px] text-muted-foreground">
				<span>{message("projects:masters_masters")}</span>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								type="button"
								aria-label={message("projects:masters_create_master")}
								disabled={creating}
								className="rounded p-1 disabled:opacity-50 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
								onClick={create}
							>
								<HugeiconsIcon icon={Add01Icon} className="size-3.5" />
							</button>
						}
					/>
					<TooltipPopup>
						{message("projects:masters_create_master")}
					</TooltipPopup>
				</Tooltip>
			</div>
			<div className="flex flex-col gap-0.5 px-1.5 pb-1">
				{visible.map((master) => (
					<MasterRow
						key={master.id}
						master={master}
						active={selection?.masterId === master.id}
					/>
				))}
				{visible.length === 0 ? (
					<SidebarActionRow
						icon={Add01Icon}
						label={message("projects:masters_create_master")}
						title={message(
							"projects:masters_one_conversation_to_coordinate_your_work",
						)}
						onClick={create}
					/>
				) : null}
			</div>
		</section>
	);
}

function MasterRow({
	master,
	active,
}: {
	readonly master: Master;
	readonly active: boolean;
}) {
	const slaves = activeSlaveCount(master);
	return (
		<SidebarActionRow
			leading={
				<Mascot
					avatar={avatarFor(master)}
					seed={master.id}
					state={master.status === "active" ? "idle" : "paused"}
				/>
			}
			label={master.settings.name}
			active={active}
			onClick={() =>
				useMastersStore.getState().select({
					environmentId: master.homeEnvironmentId,
					masterId: master.id,
				})
			}
			trailing={
				slaves > 0 ? (
					<span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
						{slaves}
					</span>
				) : null
			}
		/>
	);
}
