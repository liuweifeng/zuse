import "@zuse/i18n/english/plugins";
import type { PluginAttempt, PluginSnapshot } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	CUSTOM_SERVER_NAME_LIMIT,
	type CustomServerAuth,
	type CustomServerDraft,
	type CustomServerField,
	pluginConnectErrorKey,
	pluginTenantOf,
	validateCustomServer,
} from "~/lib/plugin-servers.ts";
import {
	notifyPluginsChanged,
	pluginRequest,
	pluginReturnTo,
} from "~/lib/plugins-client.ts";
import {
	openPluginAuthorization,
	openPluginsPage,
} from "~/lib/plugins-navigation.ts";
import { Button } from "../ui/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import { SegmentedTabs } from "../ui/segmented-tabs.tsx";
import { toastManager } from "../ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";

/** Called once the server exists: connected, or waiting for browser sign-in. */
export type McpServerAdded = (attempt: PluginAttempt, name: string) => void;

/** Away from the Plugins page, adding a server lands on it. */
const showOnPluginsPage: McpServerAdded = (attempt, name) =>
	openPluginsPage(
		attempt.state === "pending"
			? { kind: "attempt", attempt, name }
			: { kind: "plugin", pluginId: attempt.pluginId },
	);

const EMPTY_DRAFT: CustomServerDraft = {
	name: "",
	url: "",
	auth: "auto",
	token: "",
	headerName: "",
	headerValue: "",
};

type AddMcpServer = {
	readonly open: () => void;
	/** Why adding is unavailable here, or null when the user can add. */
	readonly blockedReason: string | null;
};

/**
 * Every "Add MCP server" entry point: owns the dialog and the organization
 * admin rule; callers render only their trigger.
 */
export function AddMcpServerAction({
	snapshot,
	onAdded = showOnPluginsPage,
	children,
}: {
	readonly snapshot: PluginSnapshot | null;
	readonly onAdded?: McpServerAdded;
	readonly children: (add: AddMcpServer) => ReactNode;
}) {
	const { message: m } = useMessages(["plugins"]);
	const [open, setOpen] = useState(false);
	const blockedReason =
		snapshot === null
			? m("plugins:plugins_loading")
			: snapshot.canManage
				? null
				: m("plugins:plugins_add_server_admins_only");
	return (
		<>
			{children({
				open: () => {
					if (blockedReason === null) setOpen(true);
				},
				blockedReason,
			})}
			{snapshot !== null && (
				<AddMcpServerDialog
					open={open}
					onOpenChange={setOpen}
					snapshot={snapshot}
					onAdded={onAdded}
				/>
			)}
		</>
	);
}

/** A compact trigger that explains why adding is unavailable instead of hiding it. */
export function AddMcpServerButton({
	add,
	variant = "secondary",
	disabled = false,
	className,
}: {
	readonly add: AddMcpServer;
	readonly variant?: "secondary" | "ghost";
	readonly disabled?: boolean;
	readonly className?: string;
}) {
	const { message: m } = useMessages(["plugins"]);
	const button = (
		<Button
			variant={variant}
			className={className}
			disabled={disabled || add.blockedReason !== null}
			onClick={add.open}
		>
			{m("plugins:plugins_add_server")}
		</Button>
	);
	if (add.blockedReason === null) return button;
	return (
		<Tooltip>
			<TooltipTrigger render={<span className="inline-flex" />}>
				{button}
			</TooltipTrigger>
			<TooltipPopup>{add.blockedReason}</TooltipPopup>
		</Tooltip>
	);
}

/** Add a remote MCP server by URL to the current workspace and connect its first account. */
export function AddMcpServerDialog({
	open,
	onOpenChange,
	snapshot,
	onAdded,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly snapshot: PluginSnapshot;
	readonly onAdded: McpServerAdded;
}) {
	const { message: m } = useMessages(["plugins", "common"]);
	const id = useId();
	const nameRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState<CustomServerDraft>(EMPTY_DRAFT);
	const [invalid, setInvalid] = useState<CustomServerField | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (!open) return;
		setDraft(EMPTY_DRAFT);
		setInvalid(null);
		setError(null);
		requestAnimationFrame(() => nameRef.current?.focus());
	}, [open]);

	const tenant = pluginTenantOf(snapshot);
	const workspace =
		tenant?.kind === "organization"
			? m("plugins:plugins_add_server_workspace_organization", {
					name: tenant.name,
				})
			: m("plugins:plugins_add_server_workspace_personal");

	const update = (patch: Partial<CustomServerDraft>) => {
		setDraft((current) => ({ ...current, ...patch }));
		setInvalid(null);
		setError(null);
	};

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (submitting) return;
		const checked = validateCustomServer(draft);
		if (!checked.ok) {
			setInvalid(checked.field);
			setError(m(checked.error));
			return;
		}
		setSubmitting(true);
		setError(null);
		const { name, url, apiKey } = checked.input;
		try {
			const result = await pluginRequest({
				action: "addServer",
				tenantId: snapshot.tenantId,
				requestId: crypto.randomUUID(),
				name,
				url,
				...(apiKey === undefined ? {} : { apiKey }),
				returnTo: await pluginReturnTo(),
			});
			if (result.kind !== "attempt") throw new Error("Unexpected response");
			if (result.state === "failed" || result.state === "cancelled") {
				// The server isn't kept, so the user can fix the form and retry.
				setInvalid(
					result.error === "plugin_url_rejected" ||
						result.error === "plugin_unreachable"
						? "url"
						: result.error === "plugin_credentials_rejected"
							? draft.auth === "bearer"
								? "token"
								: "value"
							: null,
				);
				setError(m(pluginConnectErrorKey(result.error, true)));
				return;
			}
			notifyPluginsChanged(snapshot.tenantId);
			onOpenChange(false);
			if (result.state === "connected")
				toastManager.add({
					title: m("plugins:plugins_add_server_added", { name }),
					description: m("plugins:plugins_connected_toast_detail"),
					type: "success",
				});
			onAdded(result, name);
			if (result.state === "pending" && result.authorizationUrl)
				await openPluginAuthorization(result.authorizationUrl);
		} catch {
			setError(m("plugins:plugins_add_server_failed"));
		} finally {
			setSubmitting(false);
		}
	};

	const errorId = `${id}-error`;
	const field = (name: CustomServerField) => ({
		"aria-invalid": invalid === name || undefined,
		"aria-describedby": invalid === name ? errorId : undefined,
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="max-w-md">
				<DialogHeader>
					<DialogTitle>{m("plugins:plugins_add_server")}</DialogTitle>
					<DialogDescription>{workspace}</DialogDescription>
				</DialogHeader>
				<form
					className="contents"
					noValidate
					onSubmit={(event) => void submit(event)}
				>
					<DialogPanel className="flex flex-col gap-3 text-xs">
						<Field
							id={`${id}-name`}
							label={m("plugins:plugins_add_server_name")}
						>
							<Input
								ref={nameRef}
								id={`${id}-name`}
								className="h-7"
								autoComplete="off"
								spellCheck={false}
								maxLength={CUSTOM_SERVER_NAME_LIMIT}
								placeholder={m("plugins:plugins_add_server_name_placeholder")}
								value={draft.name}
								onChange={(event) =>
									update({ name: event.currentTarget.value })
								}
								disabled={submitting}
								{...field("name")}
							/>
						</Field>
						<Field id={`${id}-url`} label={m("plugins:plugins_add_server_url")}>
							<Input
								id={`${id}-url`}
								className="h-7"
								type="url"
								inputMode="url"
								autoComplete="off"
								spellCheck={false}
								placeholder={m("plugins:plugins_add_server_url_placeholder")}
								value={draft.url}
								onChange={(event) => update({ url: event.currentTarget.value })}
								disabled={submitting}
								{...field("url")}
							/>
						</Field>
						<div className="flex flex-col gap-1.5">
							<span className="font-medium">
								{m("plugins:plugins_add_server_auth")}
							</span>
							<SegmentedTabs<CustomServerAuth>
								ariaLabel={m("plugins:plugins_add_server_auth")}
								value={draft.auth}
								onValueChange={(auth) => update({ auth })}
								options={[
									{ value: "auto", label: m("plugins:plugins_auth_auto") },
									{ value: "bearer", label: m("plugins:plugins_auth_bearer") },
									{ value: "header", label: m("plugins:plugins_auth_header") },
								]}
							/>
							{draft.auth === "auto" && (
								<p className="text-muted-foreground">
									{m("plugins:plugins_add_server_auth_auto_hint")}
								</p>
							)}
						</div>
						{draft.auth === "bearer" && (
							<Field
								id={`${id}-token`}
								label={m("plugins:plugins_add_server_token")}
							>
								<Input
									id={`${id}-token`}
									className="h-7 font-mono"
									type="password"
									autoComplete="off"
									spellCheck={false}
									value={draft.token}
									onChange={(event) =>
										update({ token: event.currentTarget.value })
									}
									disabled={submitting}
									{...field("token")}
								/>
							</Field>
						)}
						{draft.auth === "header" && (
							<div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
								<Field
									id={`${id}-header`}
									label={m("plugins:plugins_add_server_header_name")}
								>
									<Input
										id={`${id}-header`}
										className="h-7 font-mono"
										autoComplete="off"
										spellCheck={false}
										placeholder={m(
											"plugins:plugins_add_server_header_name_placeholder",
										)}
										value={draft.headerName}
										onChange={(event) =>
											update({ headerName: event.currentTarget.value })
										}
										disabled={submitting}
										{...field("header")}
									/>
								</Field>
								<Field
									id={`${id}-value`}
									label={m("plugins:plugins_add_server_header_value")}
								>
									<Input
										id={`${id}-value`}
										className="h-7 font-mono"
										type="password"
										autoComplete="off"
										spellCheck={false}
										value={draft.headerValue}
										onChange={(event) =>
											update({ headerValue: event.currentTarget.value })
										}
										disabled={submitting}
										{...field("value")}
									/>
								</Field>
							</div>
						)}
						{draft.auth !== "auto" && (
							<p className="text-muted-foreground">
								{m("plugins:plugins_add_server_key_hint")}
							</p>
						)}
						{error !== null && (
							<p
								id={errorId}
								role="alert"
								className="rounded-md bg-destructive/8 px-2.5 py-1.5 leading-5 text-destructive"
							>
								{error}
							</p>
						)}
					</DialogPanel>
					<DialogFooter>
						<DialogClose
							render={<Button variant="ghost" className="h-7" />}
							disabled={submitting}
						>
							{m("common:cancel")}
						</DialogClose>
						<Button
							type="submit"
							className="h-7"
							loading={submitting}
							disabled={submitting}
						>
							{m("plugins:plugins_add_server_submit")}
						</Button>
					</DialogFooter>
				</form>
			</DialogPopup>
		</Dialog>
	);
}

function Field({
	id,
	label,
	children,
}: {
	readonly id: string;
	readonly label: string;
	readonly children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<label htmlFor={id} className="font-medium">
				{label}
			</label>
			{children}
		</div>
	);
}
