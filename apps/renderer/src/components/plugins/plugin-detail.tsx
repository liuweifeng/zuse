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
import { DitherAvatar } from "../dither-kit/avatar.tsx";
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
		<>
			<nav
				aria-label={m("plugins:plugins_title")}
				className="flex h-7 min-w-0 items-center gap-1.5 text-muted-foreground"
			>
				<button
					type="button"
					onClick={onBack}
					className="rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					{m("plugins:plugins_back")}
				</button>
				<span aria-hidden className="text-muted-foreground/50">
					/
				</span>
				<span className="truncate text-foreground">{plugin.name}</span>
			</nav>
			<header className="flex flex-col gap-4">
				<PluginIcon
					name={plugin.name}
					domain={pluginDomain(plugin)}
					className="size-14 rounded-2xl text-xl"
				/>
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div className="min-w-0">
						<h1 className="flex min-w-0 items-center gap-2 text-xl font-medium tracking-[-0.01em] text-foreground">
							<span className="truncate">{plugin.name}</span>
							{plugin.custom && <CustomTag />}
						</h1>
						<p className="mt-1 truncate text-[13px] text-muted-foreground">
							{subtitleOf(plugin)}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						{(!plugin.custom || canManage) && (
							<Menu>
								<MenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon"
											className="text-muted-foreground"
											aria-label={m("plugins:plugins_more_actions")}
										/>
									}
								>
									<HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" />
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
								className="h-7"
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
								<DitherActionButton disabled={busy} onClick={startConnect}>
									<HugeiconsIcon icon={PlusSignIcon} className="size-3.5" />
									{m("plugins:plugins_connect")}
								</DitherActionButton>
							)
						)}
					</div>
				</div>
			</header>
			{plugin.description && (
				<p className="max-w-prose text-[13px] leading-5 text-foreground/85">
					{plugin.description}
				</p>
			)}
			{!canManage && (
				<p className="text-muted-foreground">
					{m("plugins:plugins_manage_admins_only")}
				</p>
			)}
			{showAccounts && (
				<DetailSection title={m("plugins:plugins_connected_accounts")}>
					<div className="overflow-hidden rounded-xl border border-border/50 bg-muted/25">
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
									className="flex items-center gap-3 border-border/40 px-4 py-3 not-first:border-t"
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
										// The key form opens on request; focus it.
										// biome-ignore lint/a11y/noAutofocus: opened by an explicit click
										autoFocus
										className="h-7 min-w-0 flex-1 rounded-md bg-background/60 px-2.5 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/24"
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
									className="flex w-full items-center gap-3 border-border/40 px-4 py-3 text-left text-[13px] text-foreground outline-none transition-colors not-first:border-t hover:bg-muted/40 focus-visible:bg-muted/40 disabled:pointer-events-none disabled:opacity-60"
								>
									<AddGlyph />
									{m("plugins:plugins_connect_another")}
								</button>
							))}
					</div>
				</DetailSection>
			)}
			<DetailSection title={m("plugins:plugins_information")}>
				<dl className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-[13px]">
					{plugin.custom ? (
						<>
							<dt className="text-muted-foreground">
								{m("plugins:plugins_add_server_url")}
							</dt>
							<dd className="truncate select-text font-mono text-xs text-foreground/85">
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
			</DetailSection>
			<p className="max-w-prose text-[11px] leading-4 text-muted-foreground">
				{m(
					organization
						? "plugins:plugins_privacy_organization"
						: "plugins:plugins_privacy",
				)}
			</p>
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
		</>
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
		<section className="flex flex-col gap-3">
			<h2 className="border-border/50 border-b pb-2.5 text-[15px] font-medium text-foreground">
				{title}
			</h2>
			{children}
		</section>
	);
}

/** The round "+" leading the add-account row, sized like an avatar. */
function AddGlyph() {
	return (
		<span
			aria-hidden
			className="grid size-8 shrink-0 place-items-center rounded-full bg-background/70 text-muted-foreground"
		>
			<HugeiconsIcon icon={PlusSignIcon} className="size-3.5" />
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
		<div className="flex items-center gap-3 border-border/40 px-4 py-3 not-first:border-t">
			<DitherAvatar
				name={connection.label}
				className={cn(
					"size-8 shrink-0 overflow-hidden rounded-full",
					!enabled && "opacity-45 grayscale",
				)}
			/>
			<div className="min-w-0 flex-1">
				<p
					className={cn(
						"truncate text-[13px] font-medium",
						enabled ? "text-foreground" : "text-muted-foreground",
					)}
				>
					{connection.label}
				</p>
				<p className="truncate text-xs text-muted-foreground">
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
								className="-mr-1.5 shrink-0 text-muted-foreground"
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
