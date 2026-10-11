import "@zuse/i18n/english/plugins";
import { HugeiconsIcon } from "@hugeicons/react";
import type { PluginSnapshot } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ArrowDown01Icon,
	PlugSocketIcon,
	PuzzleIcon,
	Search01Icon,
} from "@zuse/icons/solid-rounded";
import { useEffect, useMemo, useState } from "react";
import { usePluginConnectionToggle } from "~/hooks/use-plugin-connection-toggle.ts";
import {
	type PluginConnectionRow,
	pluginConnectionRows,
	usePluginAccount,
	usePluginTenant,
} from "~/lib/connected-plugins.ts";
import { usePluginSnapshot } from "~/lib/plugins-client.ts";
import { openPluginsPage } from "~/lib/plugins-navigation.ts";
import type { PluginsSettingsTab } from "~/store/ui.ts";
import {
	AddMcpServerAction,
	AddMcpServerButton,
} from "../plugins/add-mcp-server-dialog.tsx";
import { CustomTag } from "../plugins/custom-tag.tsx";
import { PluginConnectionSwitch } from "../plugins/plugin-connection-switch.tsx";
import { PluginIcon } from "../plugins/plugin-icon.tsx";
import { PluginsLoading } from "../plugins/plugins-loading.tsx";
import { Button } from "../ui/button.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu.tsx";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";
import { SettingsGroup } from "../ui/settings-panel.tsx";
import {
	SkillsSettingsList,
	useGlobalSkills,
} from "./skills-settings-list.tsx";

const browsePlugins = () => openPluginsPage();

/**
 * Settings → Plugins: one place to turn agent capabilities on or off —
 * workspace plugins (catalog and custom MCP servers) and skills.
 */
export function PluginsSettingsPane({
	initialTab = "plugins",
}: {
	readonly initialTab?: PluginsSettingsTab;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	const [tab, setTab] = useState<PluginsSettingsTab>(initialTab);
	const [query, setQuery] = useState("");
	useEffect(() => setTab(initialTab), [initialTab]);
	const plugins = useConnectedPluginRows();
	const skills = useGlobalSkills();

	const count = (value: number | null) =>
		value === null ? null : (
			<span className="tabular-nums text-muted-foreground">{value}</span>
		);

	return (
		<AddMcpServerAction snapshot={plugins.snapshot}>
			{(add) => (
				<div className="flex flex-col gap-4 text-xs">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<SegmentedTabs<PluginsSettingsTab>
							ariaLabel={m("plugins:plugins_title")}
							equalWidth={false}
							value={tab}
							onValueChange={setTab}
							options={[
								{
									value: "plugins",
									label: (
										<>
											{m("plugins:plugins_settings_tab_plugins")}
											{count(plugins.rows?.length ?? null)}
										</>
									),
								},
								{
									value: "skills",
									label: (
										<>
											{m("plugins:plugins_settings_tab_skills")}
											{count(skills.skills?.length ?? null)}
										</>
									),
								},
							]}
						/>
						<div className="flex items-center gap-1.5">
							<label className="flex h-7 w-48 items-center gap-2 rounded-md bg-muted/55 px-2.5 focus-within:ring-2 focus-within:ring-ring/24">
								<HugeiconsIcon
									icon={Search01Icon}
									className="size-3.5 shrink-0 text-muted-foreground"
								/>
								<input
									aria-label={m("plugins:plugins_settings_search")}
									placeholder={m("plugins:plugins_settings_search")}
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
								/>
							</label>
							<Menu>
								<MenuTrigger render={<Button variant="secondary" />}>
									{m("plugins:plugins_settings_add")}
									<HugeiconsIcon icon={ArrowDown01Icon} className="size-3" />
								</MenuTrigger>
								<MenuPopup align="end" className="w-60">
									<MenuItem onClick={browsePlugins}>
										<HugeiconsIcon icon={PuzzleIcon} className="size-3.5" />
										{m("plugins:plugins_settings_browse")}
									</MenuItem>
									{plugins.signedIn && (
										<MenuItem
											disabled={add.blockedReason !== null}
											onClick={add.open}
											className="items-start"
										>
											<HugeiconsIcon
												icon={PlugSocketIcon}
												className="mt-0.5 size-3.5"
											/>
											<span className="flex min-w-0 flex-col">
												{m("plugins:plugins_add_server")}
												{add.blockedReason !== null && (
													<span className="text-[11px] text-muted-foreground">
														{add.blockedReason}
													</span>
												)}
											</span>
										</MenuItem>
									)}
								</MenuPopup>
							</Menu>
						</div>
					</div>
					{tab === "plugins" ? (
						<ConnectedPluginList
							state={plugins}
							query={query}
							addServer={<AddMcpServerButton add={add} variant="ghost" />}
						/>
					) : (
						<SkillsSettingsList state={skills} query={query} />
					)}
				</div>
			)}
		</AddMcpServerAction>
	);
}

type ConnectedPluginRows = {
	readonly snapshot: PluginSnapshot | null;
	readonly signedIn: boolean;
	readonly rows: readonly PluginConnectionRow[] | null;
	readonly failed: boolean;
	readonly reload: () => Promise<void>;
};

function useConnectedPluginRows(): ConnectedPluginRows {
	const account = usePluginAccount();
	const { snapshot, failed, refresh } = usePluginSnapshot(
		account,
		usePluginTenant(),
	);
	const rows = useMemo(
		() => (snapshot === null ? null : pluginConnectionRows(snapshot)),
		[snapshot],
	);
	return {
		snapshot,
		signedIn: account !== null,
		rows,
		failed,
		reload: refresh,
	};
}

function ConnectedPluginList({
	state,
	query,
	addServer,
}: {
	readonly state: ConnectedPluginRows;
	readonly query: string;
	readonly addServer: React.ReactNode;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	const toggle = usePluginConnectionToggle(state.snapshot);
	const needle = query.trim().toLowerCase();
	const rows = (state.rows ?? []).filter((row) =>
		`${row.name} ${row.description}`.toLowerCase().includes(needle),
	);

	if (!state.signedIn) return <Empty>{m("plugins:plugins_sign_in")}</Empty>;
	if (state.failed && state.rows === null)
		return (
			<Empty>
				{m("plugins:plugins_load_failed")}
				<Button variant="ghost" onClick={() => void state.reload()}>
					{m("plugins:plugins_retry")}
				</Button>
			</Empty>
		);
	if (state.rows === null)
		return <PluginsLoading label={m("plugins:plugins_loading")} />;
	if (rows.length === 0)
		return (
			<Empty>
				{needle
					? m("plugins:plugins_no_results", { query: query.trim() })
					: m("plugins:plugins_none_connected")}
				{!needle && (
					<>
						<Button variant="ghost" onClick={browsePlugins}>
							{m("plugins:plugins_settings_browse")}
						</Button>
						{addServer}
					</>
				)}
			</Empty>
		);
	return (
		<SettingsGroup title={m("plugins:plugins_tab_connected")}>
			{rows.map((row) => (
				<div
					key={row.connection.id}
					className="flex items-center gap-3 px-3 py-2.5"
				>
					<PluginIcon
						name={row.name}
						domain={row.domain}
						className="size-8 rounded-lg"
					/>
					<div className="min-w-0 flex-1">
						<p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-foreground">
							<span className="truncate">{row.name}</span>
							{row.custom && <CustomTag />}
						</p>
						<p className="truncate text-muted-foreground">
							{row.custom
								? (row.plugin?.url ?? row.description)
								: row.description}
						</p>
					</div>
					<PluginConnectionSwitch
						connection={row.connection}
						name={row.name}
						toggle={toggle}
					/>
				</div>
			))}
		</SettingsGroup>
	);
}

function Empty({ children }: { readonly children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
			{children}
		</div>
	);
}
