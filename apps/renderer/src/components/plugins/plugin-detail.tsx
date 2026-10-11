import "@zuse/i18n/english/plugins";
import { HugeiconsIcon } from "@hugeicons/react";
import type { PluginConnection, PluginDefinition } from "@zuse/contracts";
import { formatDate, type MessageKey } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Copy01Icon,
	Delete02Icon,
	Link04Icon,
	MoreHorizontalIcon,
	PlusSignIcon,
	Unlink03Icon,
} from "@zuse/icons/solid-rounded";
import { type ReactNode, useState } from "react";
import type { PluginConnectionToggle } from "~/hooks/use-plugin-connection-toggle.ts";
import {
	nextPluginConnectionLabel,
	pluginConnectionName,
} from "~/lib/connected-plugins.ts";
import { copyText, openExternal } from "~/lib/platform-capabilities.ts";
import { customServerAuthOf, pluginDomain } from "~/lib/plugin-servers.ts";
import { cn } from "~/lib/utils";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import { DitherActionButton } from "../ui/dither-action-button.tsx";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { toastManager } from "../ui/toast.tsx";
import { CustomTag } from "./custom-tag.tsx";
import { PluginIcon } from "./plugin-icon.tsx";

export type PluginStatus = "available" | "connecting" | "connected";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

/** The provider's domain, or a custom server's host. */
export const subtitleOf = (plugin: PluginDefinition) => {
	if (!plugin.custom || plugin.url === null) return plugin.domain;
	try {
		return new URL(plugin.url).host;
	} catch {
		return plugin.url;
	}
};

/** How a custom server signs in, as shown in its details. */
function authLabel(m: Translate, plugin: PluginDefinition) {
	const auth = customServerAuthOf(plugin);
	return auth === "auto"
		? m("plugins:plugins_auth_auto")
		: auth === "bearer"
			? m("plugins:plugins_auth_bearer")
			: m("plugins:plugins_auth_header_named", {
					header: plugin.apiKeyHeader ?? "",
				});
}

/**
 * One plugin: what it is, the accounts connected to it, and how to add one.
 * Names are never asked for; each account gets the next free default.
 */
export function PluginDetail({
	plugin,
	status,
	connections,
	allConnections,
	canManage,
	organization,
	locked,
	toggle,
	onBack,
	onConnect,
	onDisconnect,
	onRemove,
}: {
	readonly plugin: PluginDefinition;
	readonly status: PluginStatus;
	readonly connections: readonly PluginConnection[];
	readonly allConnections: readonly PluginConnection[];
	readonly canManage: boolean;
	readonly organization: boolean;
	readonly locked: boolean;
	readonly toggle: PluginConnectionToggle;
	readonly onBack: () => void;
	readonly onConnect: (label: string, apiKey?: string) => Promise<boolean>;
	readonly onDisconnect: (connectionId: string) => void;
	readonly onRemove: () => Promise<boolean>;
}) {
	const { message: m } = useUiMessages(["plugins", "common"]);
	const [askingKey, setAskingKey] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [removing, setRemoving] = useState(false);
	const needsKey = plugin.apiKeyHeader !== null;
	const connecting = status === "connecting";
	const busy = locked || connecting;
	const label = nextPluginConnectionLabel(
		allConnections,
		plugin.id,
		plugin.name,
	);

	/** Key-authenticated servers ask for the key inline; everything else connects right away. */
	const startConnect = () => {
		if (busy) return;
		if (needsKey) setAskingKey(true);
		else void onConnect(label);
	};
	const submitKey = () => {
		if (busy || apiKey.trim().length === 0) return;
		void onConnect(label, apiKey).then((started) => {
			if (!started) return;
			setApiKey("");
			setAskingKey(false);
		});
	};
	const copyUrl = async () => {
		try {
			await copyText(plugin.url ?? "");
			toastManager.add({
				title: m("plugins:plugins_url_copied"),
				type: "success",
			});
		} catch {
			toastManager.add({
				title: m("plugins:plugins_copy_failed"),
				type: "error",
			});
		}
	};

	const showAccounts = connections.length > 0 || askingKey;
	return (
		<div className="flex flex-col gap-6 pb-8 text-[13px]">
			<div className="flex flex-col gap-4">
				<nav
					aria-label={m("plugins:plugins_title")}
					className="flex h-6 min-w-0 items-center gap-1.5 text-muted-foreground"
				>
					<button
						type="button"
						onClick={onBack}
						className="rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						{m("plugins:plugins_back")}
					</button>
					<span aria-hidden className="text-muted-foreground/40">
						/
					</span>
					<span className="truncate text-foreground">{plugin.name}</span>
				</nav>
				<header className="flex flex-col gap-3">
					<PluginIcon
						name={plugin.name}
						domain={pluginDomain(plugin)}
						className="size-12 rounded-[14px] text-lg"
					/>
					<div className="flex flex-col gap-0.5">
						{/* Actions sit on the title's line; the subtitle runs under both. */}
						<div className="flex min-h-7 items-center justify-between gap-3">
							<h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold leading-7 tracking-[-0.01em] text-foreground">
								<span className="truncate">{plugin.name}</span>
								{plugin.custom && <CustomTag />}
							</h1>
							<div className="flex shrink-0 items-center gap-1">
								{(!plugin.custom || canManage) && (
									<Menu>
										<MenuTrigger
											render={
												<Button
													variant="ghost"
													size="icon"
													className="size-7 text-muted-foreground"
													aria-label={m("plugins:plugins_more_actions")}
												/>
											}
										>
											<HugeiconsIcon
												icon={MoreHorizontalIcon}
												className="size-4"
											/>
										</MenuTrigger>
										<MenuPopup align="end" className="w-44">
											{plugin.custom ? (
												<MenuItem
													variant="destructive"
													disabled={locked}
													onClick={() => setConfirmRemove(true)}
												>
													<HugeiconsIcon icon={Delete02Icon} />
													{m("plugins:plugins_remove_server")}
												</MenuItem>
											) : (
												<MenuItem
													onClick={() =>
														void openExternal(`https://${plugin.domain}`)
													}
												>
													<HugeiconsIcon icon={Link04Icon} />
													{m("plugins:plugins_visit_website")}
												</MenuItem>
											)}
										</MenuPopup>
									</Menu>
								)}
								{plugin.custom && plugin.url !== null && (
									<Button
										variant="secondary"
										className="h-7 px-2.5"
										onClick={() => void copyUrl()}
									>
										<HugeiconsIcon icon={Copy01Icon} className="size-3.5" />
										{m("plugins:plugins_copy_url")}
									</Button>
								)}
								{connecting ? (
									<span
										role="status"
										className="flex h-7 items-center gap-1.5 px-2 text-muted-foreground"
									>
										<Spinner className="size-3.5" />
										{m("plugins:plugins_waiting")}
									</span>
								) : (
									canManage &&
									connections.length === 0 &&
									!askingKey && (
										<DitherActionButton
											className="px-[calc(--spacing(4)-1px)] text-xs"
											disabled={busy}
											onClick={startConnect}
										>
											<span className="flex items-center gap-1.5">
												<HugeiconsIcon
													icon={PlusSignIcon}
													className="size-3.5"
												/>
												{m("plugins:plugins_connect")}
											</span>
										</DitherActionButton>
									)
								)}
							</div>
						</div>
						<p className="truncate text-muted-foreground">
							{subtitleOf(plugin)}
						</p>
					</div>
				</header>
			</div>
			{(plugin.description || !canManage) && (
				<div className="flex flex-col gap-2">
					{plugin.description && (
						<p className="max-w-prose leading-5 text-foreground/85">
							{plugin.description}
						</p>
					)}
					{!canManage && (
						<p className="text-muted-foreground">
							{m("plugins:plugins_manage_admins_only")}
						</p>
					)}
				</div>
			)}
			{showAccounts && (
				<DetailSection title={m("plugins:plugins_connected_accounts")}>
					<div className="rounded-xl border border-border/60 bg-muted/20 px-3">
						<div className="divide-y divide-border/50">
							{connections.map((connection) => (
								<AccountRow
									key={connection.id}
									connection={connection}
									name={pluginConnectionName(plugin.name, connection.label)}
									canManage={canManage}
									locked={locked}
									toggle={toggle}
									onDisconnect={() => onDisconnect(connection.id)}
								/>
							))}
							{canManage &&
								(askingKey ? (
									<form
										className="flex items-center gap-2.5 py-2"
										onSubmit={(event) => {
											event.preventDefault();
											submitKey();
										}}
									>
										<AddGlyph />
										<input
											type="password"
											autoComplete="off"
											spellCheck={false}
											// biome-ignore lint/a11y/noAutofocus: opened by an explicit click
											autoFocus
											className="h-7 min-w-0 flex-1 rounded-md bg-background/70 px-2.5 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/24"
											aria-label={m("plugins:plugins_api_key")}
											placeholder={m("plugins:plugins_api_key_placeholder")}
											value={apiKey}
											onChange={(event) => setApiKey(event.target.value)}
											disabled={busy}
										/>
										<Button
											type="button"
											variant="ghost"
											className="h-7"
											onClick={() => {
												setAskingKey(false);
												setApiKey("");
											}}
										>
											{m("plugins:plugins_cancel")}
										</Button>
										<DitherActionButton
											type="submit"
											className="px-[calc(--spacing(4)-1px)] text-xs"
											disabled={busy || apiKey.trim().length === 0}
										>
											{m("plugins:plugins_connect")}
										</DitherActionButton>
									</form>
								) : (
									<button
										type="button"
										disabled={busy}
										onClick={startConnect}
										className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-2.5 px-3 py-2 text-left text-foreground outline-none transition-colors last:rounded-b-xl first:rounded-t-xl hover:bg-muted/30 focus-visible:bg-muted/30 disabled:pointer-events-none disabled:opacity-60"
									>
										<AddGlyph />
										{m("plugins:plugins_connect_another")}
									</button>
								))}
						</div>
					</div>
				</DetailSection>
			)}
			<DetailSection title={m("plugins:plugins_information")}>
				<dl className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-y-2">
					{plugin.custom ? (
						<>
							<dt className="text-muted-foreground">
								{m("plugins:plugins_add_server_url")}
							</dt>
							<dd className="truncate select-text font-mono text-xs text-foreground/90">
								{plugin.url}
							</dd>
							<dt className="text-muted-foreground">
								{m("plugins:plugins_add_server_auth")}
							</dt>
							<dd>{authLabel(m, plugin)}</dd>
						</>
					) : (
						<>
							<dt className="text-muted-foreground">
								{m("plugins:plugins_website")}
							</dt>
							<dd>
								<button
									type="button"
									className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
									onClick={() => void openExternal(`https://${plugin.domain}`)}
								>
									{plugin.domain}
									<HugeiconsIcon
										icon={Link04Icon}
										className="size-3 text-muted-foreground"
									/>
								</button>
							</dd>
							{plugin.category && (
								<>
									<dt className="text-muted-foreground">
										{m("plugins:plugins_category")}
									</dt>
									<dd className="capitalize">
										{plugin.category.replaceAll("-", " ")}
									</dd>
								</>
							)}
						</>
					)}
					<dt className="text-muted-foreground">
						{m("plugins:plugins_access")}
					</dt>
					<dd>{m("plugins:plugins_access_value")}</dd>
				</dl>
				<p className="mt-4 max-w-prose text-[11px] leading-4 text-muted-foreground">
					{m(
						organization
							? "plugins:plugins_privacy_organization"
							: "plugins:plugins_privacy",
					)}
				</p>
			</DetailSection>
			<AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{m("plugins:plugins_remove_server_title", { name: plugin.name })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m("plugins:plugins_remove_server_description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={<Button variant="ghost" className="h-7" />}
							disabled={removing}
						>
							{m("common:cancel")}
						</AlertDialogClose>
						<Button
							variant="destructive"
							className="h-7"
							loading={removing}
							onClick={() => {
								setRemoving(true);
								void onRemove().then((removed) => {
									setRemoving(false);
									if (removed) setConfirmRemove(false);
								});
							}}
						>
							{m("plugins:plugins_remove_server")}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</div>
	);
}

function DetailSection({
	title,
	children,
}: {
	readonly title: string;
	readonly children: ReactNode;
}) {
	return (
		<section className="flex flex-col">
			<h2 className="border-border/60 border-b pb-2 text-[13px] font-medium text-foreground">
				{title}
			</h2>
			<div className="pt-3">{children}</div>
		</section>
	);
}

const AVATAR = "grid size-6 shrink-0 place-items-center rounded-full";

/** The round "+" leading the add-account row, sized like an avatar. */
function AddGlyph() {
	return (
		<span
			aria-hidden
			className={cn(
				AVATAR,
				"bg-background text-muted-foreground ring-1 ring-border/60 ring-inset",
			)}
		>
			<HugeiconsIcon icon={PlusSignIcon} className="size-3" />
		</span>
	);
}

/** Initials on a hue derived from the account name: stable and distinguishable. */
function AccountAvatar({
	label,
	dimmed,
}: {
	readonly label: string;
	readonly dimmed: boolean;
}) {
	let hash = 0;
	for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	const words = label.trim().split(/\s+/).filter(Boolean);
	const initials = (
		words.length > 1
			? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
			: label.trim().slice(0, 2)
	).toUpperCase();
	return (
		<span
			aria-hidden
			className={cn(
				AVATAR,
				"text-[9px] font-semibold text-white",
				dimmed && "opacity-40 grayscale",
			)}
			style={{ backgroundColor: `oklch(0.6 0.14 ${hash % 360})` }}
		>
			{initials}
		</span>
	);
}

/** One connected account: avatar, name, state, and its own actions menu. */
function AccountRow({
	connection,
	name,
	canManage,
	locked,
	toggle,
	onDisconnect,
}: {
	readonly connection: PluginConnection;
	readonly name: string;
	readonly canManage: boolean;
	readonly locked: boolean;
	readonly toggle: PluginConnectionToggle;
	readonly onDisconnect: () => void;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	const enabled = toggle.enabled(connection);
	return (
		<div className="flex items-center gap-2.5 py-2">
			<AccountAvatar label={connection.label} dimmed={!enabled} />
			<div className="flex min-w-0 flex-1 items-baseline gap-2">
				<p
					className={cn(
						"truncate font-medium leading-5",
						enabled ? "text-foreground" : "text-muted-foreground",
					)}
				>
					{connection.label}
				</p>
				<p className="shrink-0 truncate text-xs leading-5 text-muted-foreground">
					{enabled
						? m("plugins:plugins_connected_on", {
								date: formatDate(connection.createdAt, { dateStyle: "medium" }),
							})
						: m("plugins:plugins_connection_off")}
				</p>
			</div>
			{canManage && (
				<Menu>
					<MenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon"
								className="-mr-1 size-7 shrink-0 text-muted-foreground"
								aria-label={m("plugins:plugins_account_actions", {
									name: connection.label,
								})}
							/>
						}
					>
						<HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" />
					</MenuTrigger>
					<MenuPopup align="end" className="w-48">
						<MenuItem
							disabled={!toggle.canToggle || toggle.busy(connection.id)}
							onClick={() => void toggle.toggle(connection, name, !enabled)}
						>
							{m(
								enabled
									? "plugins:plugins_turn_off"
									: "plugins:plugins_turn_on",
							)}
						</MenuItem>
						<MenuItem
							variant="destructive"
							disabled={locked}
							onClick={onDisconnect}
						>
							<HugeiconsIcon icon={Unlink03Icon} />
							{m("plugins:plugins_disconnect")}
						</MenuItem>
					</MenuPopup>
				</Menu>
			)}
		</div>
	);
}
