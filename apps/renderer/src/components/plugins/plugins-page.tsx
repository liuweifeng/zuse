import "@zuse/i18n/english/plugins";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	PluginAttempt,
	PluginConnection,
	PluginDefinition,
} from "@zuse/contracts";
import type { MessageKey } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	PlusSignIcon,
	RefreshIcon,
	Search01Icon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import {
	type ReactNode,
	useDeferredValue,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useAuth } from "~/hooks/use-auth.ts";
import { usePluginConnectionToggle } from "~/hooks/use-plugin-connection-toggle.ts";
import {
	hasPluginConnectionLabel,
	nextPluginConnectionLabel,
	usePluginAccount,
	usePluginTenant,
} from "~/lib/connected-plugins.ts";
import {
	apiKeyValue,
	pluginConnectErrorKey,
	pluginDomain,
} from "~/lib/plugin-servers.ts";
import {
	claimPluginFailure,
	pluginRequest,
	pluginReturnTo,
	usePluginSnapshot,
} from "~/lib/plugins-client.ts";
import {
	openPluginAuthorization,
	subscribePluginsPageFocus,
	takePluginsPageFocus,
} from "~/lib/plugins-navigation.ts";
import { useUiStore } from "~/store/ui.ts";
import { Button } from "../ui/button.tsx";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { toastManager } from "../ui/toast.tsx";
import {
	AddMcpServerAction,
	AddMcpServerButton,
	type McpServerAdded,
} from "./add-mcp-server-dialog.tsx";
import { CustomTag } from "./custom-tag.tsx";
import {
	PluginDetail,
	type PluginStatus,
	subtitleOf,
} from "./plugin-detail.tsx";
import { PluginIcon } from "./plugin-icon.tsx";
import { PluginsLoading } from "./plugins-loading.tsx";

type Tab = "browse" | "connected";
const PAGE_SIZE = 40;
const FEATURED_LIMIT = 12;

/** A sign-in in progress; `name` covers servers the snapshot doesn't list yet. */
type PendingAttempt = PluginAttempt & { readonly name?: string };

/** Connection failures say what to fix, for catalog plugins and custom servers alike. */
const toastConnectFailed = (
	m: (key: MessageKey, values?: Record<string, string>) => string,
	plugin: Pick<PluginDefinition, "name" | "custom"> | undefined,
	error: PluginAttempt["error"],
) =>
	toastManager.add({
		title: m("plugins:plugins_connect_failed", {
			name: plugin?.name || m("plugins:plugins_title"),
		}),
		description: m(pluginConnectErrorKey(error, plugin?.custom ?? false)),
		type: "error",
	});

function usePlugins() {
	const { message: m } = useUiMessages(["plugins"]);
	const { user, isSignedIn } = useAuth();
	const account = isSignedIn ? (user?.id ?? null) : null;
	const tenant = usePluginTenant();
	const [attempt, setAttempt] = useState<PendingAttempt | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	// Shared, persisted snapshot: shown instantly, revalidated in the background.
	const { snapshot, failed, refresh } = usePluginSnapshot(account, tenant);
	const load = refresh;

	useEffect(() => {
		setAttempt(null);
	}, [account, tenant]);

	// Resume an attempt started before the page was closed.
	const pendingId = snapshot?.connections.find(
		(connection) => connection.state === "connecting",
	);
	const pendingTenant = snapshot?.tenantId;
	useEffect(() => {
		if (pendingId === undefined || pendingTenant === undefined) return;
		let cancelled = false;
		void pluginRequest({
			action: "poll",
			tenantId: pendingTenant,
			attemptId: pendingId.id,
		})
			.then((status) => {
				if (
					!cancelled &&
					status.kind === "attempt" &&
					status.state === "pending"
				)
					setAttempt(
						(current) =>
							current ?? {
								...status,
								pluginId: status.pluginId || pendingId.pluginId,
							},
					);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [pendingId?.id, pendingId?.pluginId, pendingTenant]);

	// The browser hands the ticket to the app, which redeems it; polling only
	// notices that the attempt left `pending` so the row can settle.
	useEffect(() => {
		if (!attempt || !snapshot) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const result = await pluginRequest({
					action: "poll",
					tenantId: snapshot.tenantId,
					attemptId: attempt.id,
				});
				if (stopped) return;
				if (result.kind === "attempt" && result.state !== "pending") {
					setAttempt(null);
					if (result.state === "failed" && claimPluginFailure(result.id))
						toastConnectFailed(
							m,
							snapshot.catalog.find(
								(plugin) => plugin.id === attempt.pluginId,
							) ?? { name: attempt.name ?? "", custom: true },
							result.error,
						);
					await load();
					return;
				}
			} catch {
				// Transient; keep polling until the attempt expires server-side.
			}
			if (!stopped) timer = setTimeout(poll, 2000);
		};
		timer = setTimeout(poll, 1500);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [attempt, snapshot, load, m]);

	return {
		snapshot,
		attempt,
		setAttempt,
		busy,
		setBusy,
		failed,
		isSignedIn,
		load,
	};
}

/** Browse plugins and manage the selected workspace’s connections through the shared control plane. */
export function PluginsPage() {
	const tenant = usePluginTenant();
	const account = usePluginAccount();
	return <WorkspacePluginsPage key={`${account}:${tenant}`} />;
}

function WorkspacePluginsPage() {
	const { message: m } = useUiMessages(["plugins"]);
	const { isSignedIn, isLoading } = useAuth();
	// Plugins belong to an account: leave the page on sign-out.
	useEffect(() => {
		if (!isLoading && !isSignedIn)
			useUiStore.getState().setActiveMainTab("chat");
	}, [isLoading, isSignedIn]);
	const state = usePlugins();
	const { snapshot, attempt, busy, setAttempt } = state;
	const [tab, setTab] = useState<Tab>("browse");
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query.trim().toLowerCase());
	const [selected, setSelected] = useState<string | null>(null);
	const [limit, setLimit] = useState(PAGE_SIZE);
	const toggle = usePluginConnectionToggle(snapshot);

	// Other surfaces (settings, the composer) can land here on a plugin or a sign-in.
	useEffect(() => {
		const apply = () => {
			const focus = takePluginsPageFocus();
			if (focus === null) return;
			if (focus.kind === "plugin") setSelected(focus.pluginId);
			else {
				setSelected(null);
				setAttempt({ ...focus.attempt, name: focus.name });
			}
		};
		apply();
		return subscribePluginsPageFocus(apply);
	}, [setAttempt]);

	const connectedById = useMemo(() => {
		const map = new Map<string, PluginConnection[]>();
		for (const connection of snapshot?.connections ?? [])
			if (connection.state === "connected")
				map.set(connection.pluginId, [
					...(map.get(connection.pluginId) ?? []),
					connection,
				]);
		return map;
	}, [snapshot]);

	const catalog = snapshot?.catalog ?? [];
	const matches = useMemo(
		() =>
			catalog.filter(
				(plugin) =>
					(tab === "browse" || connectedById.has(plugin.id)) &&
					(deferredQuery.length === 0 ||
						`${plugin.name} ${plugin.description} ${plugin.domain} ${plugin.url ?? ""}`
							.toLowerCase()
							.includes(deferredQuery)),
			),
		[catalog, connectedById, deferredQuery, tab],
	);
	const catalogMatches = useMemo(
		() => matches.filter((plugin) => !plugin.custom),
		[matches],
	);
	useEffect(() => setLimit(PAGE_SIZE), [deferredQuery, tab]);

	/** Validate account names before starting an independent connection attempt. */
	const connect = async (
		plugin: PluginDefinition,
		label?: string,
		apiKey?: string,
	): Promise<boolean> => {
		if (!snapshot || busy || attempt) return false;
		// Names are optional: an empty name takes the next free default.
		const trimmedLabel =
			label?.trim() ||
			nextPluginConnectionLabel(snapshot.connections, plugin.id, plugin.name);
		if (
			hasPluginConnectionLabel(snapshot.connections, plugin.id, trimmedLabel)
		) {
			toastManager.add({
				title: m("plugins:plugins_connection_name_exists"),
				type: "error",
			});
			return false;
		}
		state.setBusy(plugin.id);
		try {
			const result = await pluginRequest({
				action: "connect",
				tenantId: snapshot.tenantId,
				pluginId: plugin.id,
				label: trimmedLabel,
				requestId: crypto.randomUUID(),
				returnTo: await pluginReturnTo(),
				...(plugin.apiKeyHeader !== null && apiKey !== undefined
					? { apiKey: apiKeyValue(plugin.apiKeyHeader, apiKey) }
					: {}),
			});
			if (result.kind !== "attempt") throw new Error("Unexpected response");
			await state.load();
			if (result.state === "connected") {
				toastManager.add({
					title: m("plugins:plugins_connected_toast", { name: plugin.name }),
					description: m("plugins:plugins_connected_toast_detail"),
					type: "success",
				});
				return true;
			}
			if (result.state === "pending") {
				setAttempt({ ...result, pluginId: plugin.id });
				if (result.authorizationUrl)
					await openPluginAuthorization(result.authorizationUrl);
				return true;
			}
			toastConnectFailed(m, plugin, result.error);
			return false;
		} catch {
			toastConnectFailed(m, plugin, null);
			await state.load();
			return false;
		} finally {
			state.setBusy(null);
		}
	};

	const cancel = async () => {
		if (!snapshot || !attempt) return;
		try {
			await pluginRequest({
				action: "cancel",
				tenantId: snapshot.tenantId,
				attemptId: attempt.id,
			});
			setAttempt(null);
			await state.load();
		} catch {
			toastManager.add({
				title: m("plugins:plugins_cancel_failed"),
				type: "error",
			});
		}
	};

	const disconnect = async (plugin: PluginDefinition, connectionId: string) => {
		if (!snapshot) return;
		state.setBusy(plugin.id);
		try {
			await pluginRequest({
				action: "disconnect",
				tenantId: snapshot.tenantId,
				connectionId,
			});
			await state.load();
		} catch {
			toastManager.add({
				title: m("plugins:plugins_disconnect_failed", { name: plugin.name }),
				type: "error",
			});
		} finally {
			state.setBusy(null);
		}
	};

	/** Removes a custom server and every account connected to it. */
	const removeServer = async (plugin: PluginDefinition): Promise<boolean> => {
		if (!snapshot) return false;
		state.setBusy(plugin.id);
		try {
			await pluginRequest({
				action: "removeServer",
				tenantId: snapshot.tenantId,
				pluginId: plugin.id,
			});
			setSelected(null);
			toastManager.add({
				title: m("plugins:plugins_remove_server_done", { name: plugin.name }),
				type: "success",
			});
			await state.load();
			return true;
		} catch {
			toastManager.add({
				title: m("plugins:plugins_remove_server_failed", { name: plugin.name }),
				type: "error",
			});
			return false;
		} finally {
			state.setBusy(null);
		}
	};

	const onServerAdded: McpServerAdded = (result, name) => {
		if (result.state === "pending") {
			setSelected(null);
			setAttempt({ ...result, name });
		} else setSelected(result.pluginId);
	};

	const statusOf = (plugin: PluginDefinition): PluginStatus =>
		attempt?.pluginId === plugin.id || busy === plugin.id
			? "connecting"
			: connectedById.has(plugin.id)
				? "connected"
				: "available";
	const pendingPlugin = attempt
		? catalog.find((plugin) => plugin.id === attempt.pluginId)
		: undefined;
	const detail = selected
		? catalog.find((plugin) => plugin.id === selected)
		: undefined;
	const canManage = snapshot?.canManage !== false;

	const rowFor = (plugin: PluginDefinition) => (
		<PluginRow
			key={plugin.id}
			plugin={plugin}
			status={statusOf(plugin)}
			locked={
				!canManage || attempt !== null || (busy !== null && busy !== plugin.id)
			}
			onOpen={() => setSelected(plugin.id)}
			onConnect={() => {
				// Key-authenticated servers need a key per account: ask on the detail page.
				if (plugin.apiKeyHeader !== null) setSelected(plugin.id);
				else void connect(plugin);
			}}
		/>
	);
	const showMore = (total: number) =>
		total > limit && (
			<ShowMore
				label={m("plugins:plugins_show_more")}
				onClick={() => setLimit((value) => value + PAGE_SIZE)}
			/>
		);

	return (
		<AddMcpServerAction snapshot={snapshot} onAdded={onServerAdded}>
			{(add) => {
				const addButton = (variant: "secondary" | "ghost") => (
					<AddMcpServerButton
						add={add}
						variant={variant}
						disabled={attempt !== null || busy !== null}
					/>
				);
				return (
					<section className="flex min-h-0 flex-1 flex-col bg-background">
						<div className="min-h-0 flex-1 overflow-y-auto">
							<div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-8 py-8 text-xs max-[800px]:px-4">
								{attempt && (
									<PendingBanner
										name={pendingPlugin?.name ?? attempt.name ?? ""}
										onReopen={
											attempt.authorizationUrl
												? () =>
														attempt.authorizationUrl &&
														void openPluginAuthorization(
															attempt.authorizationUrl,
														)
												: undefined
										}
										onCancel={() => void cancel()}
									/>
								)}
								{detail ? (
									<PluginDetail
										key={detail.id}
										plugin={detail}
										status={statusOf(detail)}
										connections={connectedById.get(detail.id) ?? []}
										allConnections={snapshot?.connections ?? []}
										canManage={canManage}
										organization={
											snapshot?.tenantId.startsWith("organization:") ?? false
										}
										locked={!canManage || attempt !== null || busy !== null}
										toggle={toggle}
										onBack={() => setSelected(null)}
										onConnect={(label, apiKey) =>
											connect(detail, label, apiKey)
										}
										onDisconnect={(id) => void disconnect(detail, id)}
										onRemove={() => removeServer(detail)}
									/>
								) : (
									<>
										<header className="flex flex-wrap items-start justify-between gap-4">
											<div className="min-w-0">
												<h1 className="text-xl font-medium tracking-[-0.01em] text-foreground">
													{m("plugins:plugins_title")}
												</h1>
												<p className="mt-1 text-muted-foreground">
													{m("plugins:plugins_subtitle")}
												</p>
											</div>
											<div className="flex items-center gap-1.5">
												<label className="flex h-7 w-56 items-center gap-2 rounded-md bg-muted/55 px-2.5 focus-within:ring-2 focus-within:ring-ring/24">
													<HugeiconsIcon
														icon={Search01Icon}
														className="size-3.5 shrink-0 text-muted-foreground"
													/>
													<input
														aria-label={m("plugins:plugins_search")}
														placeholder={m("plugins:plugins_search")}
														value={query}
														onChange={(event) => setQuery(event.target.value)}
														className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
													/>
												</label>
												{state.isSignedIn && addButton("secondary")}
												<Button
													variant="ghost"
													size="icon"
													aria-label={m("plugins:plugins_refresh")}
													onClick={() => void state.load()}
												>
													<HugeiconsIcon
														icon={RefreshIcon}
														className="size-3.5"
													/>
												</Button>
											</div>
										</header>
										<div className="flex items-center justify-between gap-3">
											<SegmentedTabs<Tab>
												ariaLabel={m("plugins:plugins_title")}
												equalWidth={false}
												value={tab}
												onValueChange={setTab}
												options={[
													{
														value: "browse",
														label: m("plugins:plugins_tab_browse"),
													},
													{
														value: "connected",
														label: (
															<>
																{m("plugins:plugins_tab_connected")}
																{connectedById.size > 0 && (
																	<span className="tabular-nums text-muted-foreground">
																		{connectedById.size}
																	</span>
																)}
															</>
														),
													},
												]}
											/>
										</div>
										{!state.isSignedIn ? (
											<p className="py-8 text-muted-foreground">
												{m("plugins:plugins_sign_in")}
											</p>
										) : state.failed && !snapshot ? (
											<div
												role="alert"
												className="flex items-center gap-3 py-8 text-muted-foreground"
											>
												<p className="flex-1">
													{m("plugins:plugins_load_failed")}
												</p>
												<Button
													variant="ghost"
													onClick={() => void state.load()}
													className="shrink-0"
												>
													{m("plugins:plugins_retry")}
												</Button>
											</div>
										) : !snapshot ? (
											<PluginsLoading label={m("plugins:plugins_loading")} />
										) : matches.length === 0 ? (
											deferredQuery ? (
												<p className="py-12 text-center text-muted-foreground">
													{m("plugins:plugins_no_results", {
														query: query.trim(),
													})}
												</p>
											) : (
												<div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
													<p>{m("plugins:plugins_none_connected")}</p>
													<div className="flex items-center gap-1.5">
														<Button
															variant="secondary"
															onClick={() => setTab("browse")}
														>
															{m("plugins:plugins_settings_browse")}
														</Button>
														{addButton("ghost")}
													</div>
												</div>
											)
										) : tab === "browse" && deferredQuery.length === 0 ? (
											<>
												{matches.some((plugin) => plugin.custom) && (
													<PluginSection
														title={m("plugins:plugins_custom_servers")}
													>
														{matches
															.filter((plugin) => plugin.custom)
															.map(rowFor)}
													</PluginSection>
												)}
												<PluginSection title={m("plugins:plugins_featured")}>
													{catalogMatches
														.filter((plugin) => plugin.featured)
														.slice(0, FEATURED_LIMIT)
														.map(rowFor)}
												</PluginSection>
												<PluginSection title={m("plugins:plugins_all")}>
													{catalogMatches.slice(0, limit).map(rowFor)}
												</PluginSection>
												{showMore(catalogMatches.length)}
											</>
										) : (
											<>
												<PluginSection
													title={
														tab === "connected"
															? m("plugins:plugins_tab_connected")
															: m("plugins:plugins_results")
													}
												>
													{matches.slice(0, limit).map(rowFor)}
												</PluginSection>
												{showMore(matches.length)}
											</>
										)}
									</>
								)}
							</div>
						</div>
					</section>
				);
			}}
		</AddMcpServerAction>
	);
}

function PluginSection({
	title,
	children,
}: {
	readonly title: string;
	readonly children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-1">
			<h2 className="px-2 pb-1 text-[13px] font-medium text-foreground">
				{title}
			</h2>
			<div className="grid grid-cols-1 gap-x-4 gap-y-0.5 lg:grid-cols-2">
				{children}
			</div>
		</section>
	);
}

function ShowMore({
	label,
	onClick,
}: {
	readonly label: string;
	readonly onClick: () => void;
}) {
	return (
		<Button variant="ghost" className="self-center" onClick={onClick}>
			{label}
		</Button>
	);
}

function PluginRow({
	plugin,
	status,
	locked,
	onOpen,
	onConnect,
}: {
	readonly plugin: PluginDefinition;
	readonly status: PluginStatus;
	readonly locked: boolean;
	readonly onOpen: () => void;
	readonly onConnect: () => void;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	return (
		<div className="flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/45">
			<button
				type="button"
				onClick={onOpen}
				className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<PluginIcon name={plugin.name} domain={pluginDomain(plugin)} />
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-foreground">
						<span className="truncate">{plugin.name}</span>
						{plugin.custom && <CustomTag />}
					</span>
					<span className="block truncate text-muted-foreground">
						{plugin.custom
							? plugin.description || subtitleOf(plugin)
							: plugin.description}
					</span>
				</span>
			</button>
			{status === "connecting" ? (
				<span
					role="status"
					aria-label={m("plugins:plugins_connecting_named", {
						name: plugin.name,
					})}
					className="grid size-7 shrink-0 place-items-center text-muted-foreground"
				>
					<Spinner className="size-3.5" />
				</span>
			) : status === "connected" ? (
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0 text-muted-foreground"
					aria-label={m("plugins:plugins_manage_named", { name: plugin.name })}
					onClick={onOpen}
				>
					<HugeiconsIcon icon={Tick02Icon} className="size-4" />
				</Button>
			) : (
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0"
					aria-label={m("plugins:plugins_connect_named", { name: plugin.name })}
					disabled={locked}
					onClick={onConnect}
				>
					<HugeiconsIcon icon={PlusSignIcon} className="size-4" />
				</Button>
			)}
		</div>
	);
}

function PendingBanner({
	name,
	onReopen,
	onCancel,
}: {
	readonly name: string;
	readonly onReopen: (() => void) | undefined;
	readonly onCancel: () => void;
}) {
	const { message: m } = useUiMessages(["plugins"]);
	return (
		<div
			role="status"
			className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 py-1.5 pl-3 pr-1.5"
		>
			<Spinner className="size-3.5 text-muted-foreground" />
			<span className="min-w-0 flex-1 text-muted-foreground">
				{m("plugins:plugins_pending", { name })}
			</span>
			{onReopen && (
				<Button variant="ghost" onClick={onReopen}>
					{m("plugins:plugins_reopen")}
				</Button>
			)}
			<Button variant="ghost" onClick={onCancel}>
				{m("plugins:plugins_cancel")}
			</Button>
		</div>
	);
}
