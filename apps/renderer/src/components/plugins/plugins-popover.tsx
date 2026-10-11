import "@zuse/i18n/english/plugins";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMessages } from "@zuse/i18n/react";
import { PuzzleIcon } from "@zuse/icons/solid-rounded";
import { useMemo, useState } from "react";
import { usePluginConnectionToggle } from "~/hooks/use-plugin-connection-toggle.ts";
import {
	pluginConnectionRows,
	usePluginAccount,
	usePluginTenant,
} from "~/lib/connected-plugins.ts";
import { pluginTenantOf } from "~/lib/plugin-servers.ts";
import { usePluginSnapshot } from "~/lib/plugins-client.ts";
import { openPluginsPage } from "~/lib/plugins-navigation.ts";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";
import { AddMcpServerAction } from "./add-mcp-server-dialog.tsx";
import { CustomTag } from "./custom-tag.tsx";
import { PluginConnectionSwitch } from "./plugin-connection-switch.tsx";
import { PluginIcon } from "./plugin-icon.tsx";

const footerAction =
	"flex h-7 min-w-0 flex-1 items-center justify-center rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/**
 * Composer control for the workspace's plugins: what agents in this chat can
 * use, with quick on/off switches. Reads the shared plugin snapshot cache.
 */
export function PluginsPopover() {
	const account = usePluginAccount();
	if (account === null) return null;
	return <WorkspacePluginsPopover account={account} />;
}

function WorkspacePluginsPopover({ account }: { readonly account: string }) {
	const { message: m } = useMessages(["plugins"]);
	const [open, setOpen] = useState(false);
	const { snapshot } = usePluginSnapshot(account, usePluginTenant());
	const toggle = usePluginConnectionToggle(snapshot);
	const rows = useMemo(
		() => (snapshot === null ? null : pluginConnectionRows(snapshot)),
		[snapshot],
	);
	const tenant = snapshot === null ? null : pluginTenantOf(snapshot);
	const enabledCount =
		rows?.filter((row) => toggle.enabled(row.connection)).length ?? 0;

	return (
		<AddMcpServerAction snapshot={snapshot}>
			{(add) => (
				<Popover open={open} onOpenChange={setOpen}>
					<Tooltip>
						<TooltipTrigger
							render={
								<PopoverTrigger
									aria-label={m("plugins:plugins_title")}
									className={cn(
										"flex size-5 items-center justify-center rounded-sm transition-colors hover:bg-muted/60",
										open
											? "bg-muted/60 text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									<HugeiconsIcon icon={PuzzleIcon} className="size-3" />
								</PopoverTrigger>
							}
						/>
						<TooltipPopup>{m("plugins:plugins_title")}</TooltipPopup>
					</Tooltip>
					<PopoverPopup
						side="top"
						align="start"
						className="w-80 [&_[data-slot=popover-viewport]]:!overflow-hidden [&_[data-slot=popover-viewport]]:p-px [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:1px]"
					>
						<div className="flex h-8 shrink-0 items-center justify-between gap-2 border-border/40 border-b px-2">
							<span className="text-[13px] font-medium text-foreground">
								{m("plugins:plugins_title")}
							</span>
							{tenant !== null && (
								<span className="min-w-0 truncate text-[11px] text-muted-foreground">
									{tenant.kind === "organization"
										? tenant.name
										: m("plugins:plugins_workspace_personal")}
								</span>
							)}
						</div>
						<div className="max-h-[min(20rem,calc(var(--available-height)-5rem))] overflow-y-auto overscroll-y-contain py-1">
							{rows === null ? (
								<p className="px-2 py-2 text-[12px] text-muted-foreground">
									{m("plugins:plugins_loading")}
								</p>
							) : rows.length === 0 ? (
								<p className="px-2 py-2 text-[12px] leading-relaxed text-muted-foreground">
									{m("plugins:plugins_popover_empty")}
								</p>
							) : (
								rows.map((row) => (
									<div
										key={row.connection.id}
										className="flex h-8 items-center gap-2 px-2"
									>
										<PluginIcon
											name={row.name}
											domain={row.domain}
											className="size-5 rounded-[5px] text-[10px]"
										/>
										<span
											className={cn(
												"min-w-0 truncate text-[13px]",
												toggle.enabled(row.connection)
													? "text-foreground"
													: "text-muted-foreground",
											)}
											title={row.name}
										>
											{row.name}
										</span>
										{row.custom && <CustomTag />}
										<span className="flex-1" />
										<PluginConnectionSwitch
											connection={row.connection}
											name={row.name}
											toggle={toggle}
										/>
									</div>
								))
							)}
							{snapshot !== null && !snapshot.canManage && (
								<p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
									{m("plugins:plugins_manage_admins_only")}
								</p>
							)}
						</div>
						<div className="flex shrink-0 items-center gap-0.5 border-border/40 border-t p-0.5">
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									openPluginsPage();
								}}
								className={footerAction}
							>
								<span className="truncate">
									{m("plugins:plugins_popover_manage")}
								</span>
								{rows !== null && rows.length > 0 && (
									<span className="ml-1.5 text-[11px] tabular-nums">
										{m("plugins:plugins_popover_enabled_count", {
											enabled: enabledCount,
											total: rows.length,
										})}
									</span>
								)}
							</button>
							<button
								type="button"
								disabled={add.blockedReason !== null}
								title={add.blockedReason ?? undefined}
								onClick={() => {
									setOpen(false);
									add.open();
								}}
								className={footerAction}
							>
								<span className="truncate">
									{m("plugins:plugins_add_server")}
								</span>
							</button>
						</div>
					</PopoverPopup>
				</Popover>
			)}
		</AddMcpServerAction>
	);
}
