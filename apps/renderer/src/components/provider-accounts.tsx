import "@zuse/i18n/english/providers";
import type { NativeAccountProvider, ProviderAccount } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { MoreHorizontal, Plus, SquareTerminal } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { formatError } from "../lib/format-error.ts";
import {
	type ProviderAccountOperation,
	runProviderAccountOperation,
	suggestAccountName,
	useProviderAccounts,
} from "../lib/provider-accounts.ts";
import {
	openExternal,
	startProviderAccountLogin,
	useProviderLogin,
} from "../lib/use-provider-login.ts";
import { cn } from "../lib/utils.ts";
import {
	AlertDialog,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "./ui/menu.tsx";
import { ShimmerText } from "./ui/shimmer-text.tsx";

type Run = (operation: ProviderAccountOperation) => Promise<boolean>;

const AVATAR_TONES = [
	"bg-sky-500/20 text-sky-300",
	"bg-violet-500/20 text-violet-300",
	"bg-emerald-500/20 text-emerald-300",
	"bg-amber-500/20 text-amber-300",
	"bg-rose-500/20 text-rose-300",
	"bg-fuchsia-500/20 text-fuchsia-300",
] as const;

const initials = (name: string) =>
	name
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map((part) => part.charAt(0))
		.join("")
		.toUpperCase();

/**
 * Round account avatar: the account's initials on a stable tone derived from
 * its id, or a terminal glyph for the default CLI login (`id === null`).
 */
export function AccountAvatar({
	id,
	name,
	className,
}: {
	id: string | null;
	name: string;
	className?: string;
}) {
	const tone =
		id === null
			? "bg-foreground/[0.07] text-muted-foreground"
			: AVATAR_TONES[
					[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
						AVATAR_TONES.length
				];
	return (
		<span
			aria-hidden
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-full font-semibold text-[9px]",
				tone,
				className,
			)}
		>
			{id === null ? <SquareTerminal className="size-3" /> : initials(name)}
		</span>
	);
}

/**
 * Native CLI accounts for one provider on one computer. One account is the
 * default for new chats; a chat keeps its account until the user switches it
 * from the composer.
 */
export function ProviderAccountsControls({
	providerId,
	environmentId,
}: {
	providerId: NativeAccountProvider;
	environmentId: string;
}) {
	const { message: t } = useMessages(["providers", "common"]);
	const {
		available,
		accounts,
		loaded,
		error: loadError,
	} = useProviderAccounts(environmentId, providerId);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run: Run = async (operation) => {
		if (busy) return false;
		setBusy(true);
		setError(null);
		try {
			await runProviderAccountOperation(environmentId, providerId, operation);
			return true;
		} catch (cause) {
			setError(formatError(cause));
			return false;
		} finally {
			setBusy(false);
		}
	};
	// Connecting means signing in: create the account under a suggested name
	// (renamable later) and open the provider's login straight away.
	const connect = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const account = await runProviderAccountOperation(
				environmentId,
				providerId,
				{
					kind: "save",
					name: suggestAccountName(accounts, (index) =>
						t("providers:accounts_suggested_name", { index }),
					),
				},
			);
			if (account)
				void startProviderAccountLogin(environmentId, providerId, account.id);
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			setBusy(false);
		}
	};
	const shownError = error ?? loadError;
	if (!loaded || (!available && !shownError)) return null;
	const defaultSelected = !accounts.some((account) => account.preferred);
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-baseline gap-1.5">
				<span className="font-medium text-[11px] text-muted-foreground">
					{t("providers:accounts_title")}
				</span>
				{available && (
					<span className="text-[10px] text-muted-foreground/70">
						{accounts.length + 1}
					</span>
				)}
			</div>
			{available && (
				<div className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-md bg-muted/30">
					<AccountRow
						avatar={
							<AccountAvatar id={null} name={t("providers:accounts_default")} />
						}
						label={t("providers:accounts_default")}
						isDefault={defaultSelected}
						detail={t("providers:accounts_default_detail")}
						actions={
							defaultSelected ? null : (
								<AccountMenu
									label={t("providers:accounts_actions", {
										name: t("providers:accounts_default"),
									})}
									disabled={busy}
								>
									<MenuItem
										className="h-7"
										onClick={() => void run({ kind: "preferred", id: null })}
									>
										{t("providers:accounts_use_for_new_chats")}
									</MenuItem>
								</AccountMenu>
							)
						}
					/>
					{accounts.map((account) => (
						<ProviderAccountRow
							key={account.id}
							account={account}
							environmentId={environmentId}
							busy={busy}
							error={error}
							run={run}
						/>
					))}
					<button
						type="button"
						disabled={busy}
						onClick={() => void connect()}
						className="group/connect flex min-h-9 items-center gap-2.5 px-2.5 py-1.5 text-left text-muted-foreground text-xs outline-none transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:bg-muted/40 disabled:opacity-60"
					>
						<span
							aria-hidden
							className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 border-dashed group-hover/connect:border-muted-foreground"
						>
							<Plus className="size-3" />
						</span>
						{t("providers:accounts_connect")}
					</button>
				</div>
			)}
			{available && (
				<p className="text-[10px] text-muted-foreground/70 leading-snug">
					{t("providers:accounts_hint")}
				</p>
			)}
			{shownError && (
				<p role="alert" className="text-[11px] text-destructive">
					{shownError}
				</p>
			)}
		</div>
	);
}

/**
 * One account line: avatar, name with an optional "Default" badge, then a
 * muted detail on the same line and trailing actions.
 */
function AccountRow({
	avatar,
	label,
	isDefault = false,
	detail,
	actions,
}: {
	avatar: ReactNode;
	label: string;
	isDefault?: boolean;
	detail?: ReactNode;
	actions?: ReactNode;
}) {
	const { message: t } = useMessages(["providers"]);
	return (
		<div className="group/account flex min-h-9 items-center gap-2.5 px-2.5 py-1.5">
			{avatar}
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<span className="min-w-0 truncate text-foreground text-xs">
					{label}
				</span>
				{isDefault && (
					<span className="shrink-0 rounded-full bg-foreground/[0.08] px-1.5 py-px font-medium text-[10px] text-foreground/80">
						{t("providers:accounts_default_badge")}
					</span>
				)}
				{detail !== undefined && (
					<span className="flex min-w-0 truncate text-[11px] text-muted-foreground">
						{detail}
					</span>
				)}
			</div>
			{actions}
		</div>
	);
}

function AccountMenu({
	label,
	disabled,
	children,
}: {
	label: string;
	disabled: boolean;
	children: ReactNode;
}) {
	return (
		<Menu>
			<MenuTrigger
				render={
					<Button
						className="size-6 text-muted-foreground opacity-60 group-hover/account:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
						size="icon-xs"
						variant="ghost"
						disabled={disabled}
						aria-label={label}
					/>
				}
			>
				<MoreHorizontal className="size-3.5" />
			</MenuTrigger>
			<MenuPopup align="end">{children}</MenuPopup>
		</Menu>
	);
}

function AccountNameForm({
	initialName,
	busy,
	onCancel,
	onSubmit,
}: {
	initialName: string;
	busy: boolean;
	onCancel: () => void;
	onSubmit: (name: string) => Promise<void>;
}) {
	const { message: t } = useMessages(["providers", "common"]);
	const [name, setName] = useState(initialName);
	return (
		<form
			className="flex min-w-0 flex-1 items-center gap-1"
			onSubmit={(event) => {
				event.preventDefault();
				if (name.trim()) void onSubmit(name);
			}}
		>
			<Input
				className="h-7 min-w-0 flex-1"
				autoFocus
				required
				maxLength={80}
				value={name}
				aria-label={t("providers:accounts_name")}
				onFocus={(event) => event.currentTarget.select()}
				onChange={(event) => setName(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						onCancel();
					}
				}}
			/>
			<Button
				className="h-7"
				size="sm"
				type="submit"
				loading={busy}
				disabled={!name.trim()}
			>
				{t("common:save")}
			</Button>
			<Button
				className="h-7"
				size="sm"
				variant="ghost"
				type="button"
				disabled={busy}
				onClick={onCancel}
			>
				{t("common:cancel")}
			</Button>
		</form>
	);
}

function ProviderAccountRow({
	account,
	environmentId,
	busy,
	error,
	run,
}: {
	account: ProviderAccount;
	environmentId: string;
	busy: boolean;
	error: string | null;
	run: Run;
}) {
	const { message: t } = useMessages(["providers", "common"]);
	const [renaming, setRenaming] = useState(false);
	const [removing, setRemoving] = useState(false);
	const removalPending = useRef(false);
	const confirmRemoval = async () => {
		if (busy || removalPending.current) return;
		removalPending.current = true;
		try {
			if (await run({ kind: "remove", id: account.id })) setRemoving(false);
		} finally {
			removalPending.current = false;
		}
	};
	const login = useProviderLogin(account.providerId, {
		environmentId,
		accountId: account.id,
	});
	const state = login.state;
	const avatar = <AccountAvatar id={account.id} name={account.name} />;
	if (renaming) {
		return (
			<div className="flex min-h-9 items-center gap-2.5 py-1 pr-1 pl-2.5">
				{avatar}
				<AccountNameForm
					initialName={account.name}
					busy={busy}
					onCancel={() => setRenaming(false)}
					onSubmit={async (name) => {
						if (await run({ kind: "save", id: account.id, name }))
							setRenaming(false);
					}}
				/>
			</div>
		);
	}
	const detail =
		state.kind === "waiting" ? (
			<ShimmerText as="span" className="min-w-0 truncate">
				{state.output || t("providers:accounts_waiting")}
			</ShimmerText>
		) : state.kind === "failed" ? (
			<span
				role="alert"
				title={state.reason}
				className="min-w-0 truncate text-destructive"
			>
				{state.reason}
			</span>
		) : state.kind === "success" ? (
			<span role="status">{t("providers:accounts_signed_in")}</span>
		) : undefined;
	const textAction =
		"h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground";
	return (
		<>
			<AccountRow
				avatar={avatar}
				label={account.name}
				isDefault={account.preferred}
				detail={detail}
				actions={
					state.kind === "waiting" ? (
						<div className="flex shrink-0 items-center">
							{state.url && (
								<Button
									className={textAction}
									size="xs"
									variant="ghost"
									onClick={() => {
										if (state.url) void openExternal(state.url);
									}}
								>
									{t("providers:accounts_open_browser")}
								</Button>
							)}
							<Button
								className={textAction}
								size="xs"
								variant="ghost"
								onClick={login.cancel}
							>
								{t("common:cancel")}
							</Button>
						</div>
					) : (
						<div className="flex shrink-0 items-center">
							{state.kind === "failed" && (
								<Button
									className={textAction}
									size="xs"
									variant="ghost"
									onClick={() => void login.start()}
								>
									{t("common:retry")}
								</Button>
							)}
							<AccountMenu
								label={t("providers:accounts_actions", { name: account.name })}
								disabled={busy}
							>
								{!account.preferred && (
									<MenuItem
										className="h-7"
										onClick={() =>
											void run({ kind: "preferred", id: account.id })
										}
									>
										{t("providers:accounts_use_for_new_chats")}
									</MenuItem>
								)}
								<MenuItem className="h-7" onClick={() => void login.start()}>
									{t("providers:accounts_sign_in_again")}
								</MenuItem>
								<MenuItem className="h-7" onClick={() => setRenaming(true)}>
									{t("providers:accounts_rename")}
								</MenuItem>
								<MenuSeparator />
								<MenuItem
									className="h-7"
									variant="destructive"
									onClick={() => setRemoving(true)}
								>
									{t("common:remove")}
								</MenuItem>
							</AccountMenu>
						</div>
					)
				}
			/>
			<AlertDialog
				open={removing}
				onOpenChange={(open) => {
					if (!removalPending.current) setRemoving(open);
				}}
			>
				<AlertDialogPopup className="max-w-sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("common:removeNamedItem", { value: account.name })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("providers:accounts_remove_description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error && (
						<p role="alert" className="px-4 text-destructive text-xs">
							{error}
						</p>
					)}
					<AlertDialogFooter>
						<Button
							className="h-7"
							variant="ghost"
							disabled={busy}
							onClick={() => setRemoving(false)}
						>
							{t("common:cancel")}
						</Button>
						<Button
							className="h-7"
							variant="destructive"
							disabled={busy}
							loading={busy}
							onClick={() => void confirmRemoval()}
						>
							{t("common:remove")}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}
