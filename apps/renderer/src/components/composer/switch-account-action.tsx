import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import "@zuse/i18n/english/providers";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { EnvironmentId, NativeAccountProvider } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import {
	ArrowDown01Icon,
	ArrowRight02Icon,
	ArrowShrink02Icon,
	UserSwitchIcon,
} from "@zuse/icons/stroke-rounded";
import { type ReactNode, useId, useState } from "react";

import { formatError } from "../../lib/format-error.ts";
import {
	runProviderAccountOperation,
	useProviderAccounts,
} from "../../lib/provider-accounts.ts";
import {
	clearSessionCommandError,
	compactAndContinueSession,
	retryLastSessionMessage,
} from "../../lib/session-actions.ts";
import { AccountAvatar } from "../provider-accounts.tsx";
import {
	AlertDialog,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuRadioGroup,
	MenuRadioItem,
	MenuTrigger,
} from "../ui/menu.tsx";
import { SplitButton } from "../ui/split-button.tsx";
import { Switch } from "../ui/switch.tsx";

type Option = { readonly id: string | null; readonly name: string };
const optionKey = (option: Option) => option.id ?? "default";

/**
 * "Switch to <account>" for a chat stopped by a usage limit. The chevron
 * offers the two ways to continue (full history or compact first); the
 * dialog confirms the from → to accounts and lets the user pick another
 * target. Renders `fallback` when this computer has no other login.
 */
export function SwitchAccountAction({
	sessionRef,
	environmentId,
	providerId,
	onSwitched,
	fallback = null,
}: {
	sessionRef: SessionRef;
	environmentId: EnvironmentId;
	providerId: NativeAccountProvider;
	onSwitched: () => void;
	fallback?: ReactNode;
}) {
	const { message: t } = useMessages(["chat", "common", "providers"]);
	const { available, accounts, sessionAccountId } = useProviderAccounts(
		environmentId,
		providerId,
		{ sessionId: sessionRef.sessionId },
	);
	const [request, setRequest] = useState<{
		targetId: string;
		compact: boolean;
	} | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const compactId = useId();

	const all: Option[] = [
		{ id: null, name: t("providers:accounts_default") },
		...accounts.map((account) => ({ id: account.id, name: account.name })),
	];
	const currentId = sessionAccountId ?? null;
	const current = all.find((option) => option.id === currentId) ?? all[0];
	const targets = all.filter((option) => option.id !== currentId);
	// Prefer the account chosen for new chats; it is usually the fresh one.
	const preferredId = accounts.find((account) => account.preferred)?.id ?? null;
	const suggested =
		targets.find((option) => option.id === preferredId) ?? targets[0];
	if (!available || current === undefined || suggested === undefined)
		return <>{fallback}</>;
	const target =
		targets.find((option) => optionKey(option) === request?.targetId) ??
		suggested;

	const open = (compact: boolean) => {
		setError(null);
		setRequest({ targetId: optionKey(suggested), compact });
	};
	const confirm = async () => {
		if (request === null || pending) return;
		setPending(true);
		setError(null);
		try {
			await runProviderAccountOperation(environmentId, providerId, {
				kind: "switchSession",
				sessionId: sessionRef.sessionId,
				id: target.id,
			});
		} catch (cause) {
			setError(formatError(cause));
			setPending(false);
			return;
		}
		clearSessionCommandError(sessionRef);
		onSwitched();
		setPending(false);
		setRequest(null);
		if (request.compact) void compactAndContinueSession(sessionRef, providerId);
		else void retryLastSessionMessage(sessionRef, providerId);
	};

	return (
		<>
			<SplitButton
				icon={<HugeiconsIcon icon={UserSwitchIcon} className="size-3.5" />}
				label={t("chat:switch_account_to", { name: suggested.name })}
				onClick={() => open(false)}
				menuLabel={t("chat:switch_account_more")}
				menu={
					<>
						<ModeItem
							icon={UserSwitchIcon}
							title={t("chat:switch_account_confirm")}
							detail={t("chat:switch_account_retry_detail")}
							onClick={() => open(false)}
						/>
						<ModeItem
							icon={ArrowShrink02Icon}
							title={t("chat:switch_account_compact")}
							detail={t("chat:switch_account_compact_detail")}
							onClick={() => open(true)}
						/>
					</>
				}
			/>
			<AlertDialog
				open={request !== null}
				onOpenChange={(next) => {
					if (!next && !pending) setRequest(null);
				}}
			>
				{request !== null && (
					<AlertDialogPopup className="max-w-[22rem]">
						<AlertDialogHeader className="px-4 pt-4 pb-3">
							<AlertDialogTitle>
								{t("chat:switch_account_confirm_title", { name: target.name })}
							</AlertDialogTitle>
						</AlertDialogHeader>
						<div className="flex flex-col gap-3 px-4 pb-4">
							<div className="flex h-10 items-center gap-2 rounded-lg bg-muted/40 pr-1 pl-2.5">
								<span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
									<AccountAvatar id={current.id} name={current.name} />
									<span className="truncate">{current.name}</span>
								</span>
								<HugeiconsIcon
									icon={ArrowRight02Icon}
									className="size-3.5 shrink-0 text-muted-foreground/70"
									aria-hidden
								/>
								<TargetPicker
									targets={targets}
									target={target}
									label={t("chat:switch_account_choose")}
									disabled={pending}
									onChange={(option) =>
										setRequest({ ...request, targetId: optionKey(option) })
									}
								/>
							</div>
							<div className="flex items-center gap-3 rounded-lg bg-muted/40 py-2 pr-2.5 pl-3">
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<label
										htmlFor={compactId}
										className="cursor-pointer text-foreground text-xs"
									>
										{t("chat:switch_account_compact_first")}
									</label>
									<span
										id={`${compactId}-detail`}
										className="text-[11px] text-muted-foreground leading-4"
									>
										{t("chat:switch_account_compact_first_detail")}
									</span>
								</span>
								<Switch
									id={compactId}
									aria-describedby={`${compactId}-detail`}
									checked={request.compact}
									disabled={pending}
									onCheckedChange={(compact) =>
										setRequest({ ...request, compact })
									}
								/>
							</div>
							<p className="text-[11px] text-muted-foreground leading-4">
								{request.compact
									? t("chat:switch_account_compact_warning", {
											name: target.name,
										})
									: t("chat:switch_account_cache_warning", {
											name: target.name,
										})}
							</p>
							{error && (
								<p role="alert" className="text-[11px] text-destructive">
									{error}
								</p>
							)}
						</div>
						<AlertDialogFooter className="px-4 py-2">
							<Button
								className="h-7"
								variant="ghost"
								disabled={pending}
								onClick={() => setRequest(null)}
							>
								{t("common:cancel")}
							</Button>
							<Button
								className="h-7"
								loading={pending}
								onClick={() => void confirm()}
							>
								{request.compact
									? t("chat:switch_account_compact")
									: t("chat:switch_account_confirm")}
							</Button>
						</AlertDialogFooter>
					</AlertDialogPopup>
				)}
			</AlertDialog>
		</>
	);
}

function ModeItem({
	icon,
	title,
	detail,
	onClick,
}: {
	icon: typeof UserSwitchIcon;
	title: string;
	detail: string;
	onClick: () => void;
}) {
	return (
		<MenuItem className="items-start gap-2.5 px-2 py-1.5" onClick={onClick}>
			<HugeiconsIcon
				icon={icon}
				className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
			/>
			<span className="flex min-w-0 flex-col">
				<span className="text-foreground text-xs">{title}</span>
				<span className="text-[11px] text-muted-foreground">{detail}</span>
			</span>
		</MenuItem>
	);
}

/** The "to" account: a plain label with one target, a dropdown with several. */
function TargetPicker({
	targets,
	target,
	label,
	disabled,
	onChange,
}: {
	targets: readonly Option[];
	target: Option;
	label: string;
	disabled: boolean;
	onChange: (option: Option) => void;
}) {
	const body = (
		<>
			<AccountAvatar id={target.id} name={target.name} />
			<span className="truncate font-medium text-foreground text-xs">
				{target.name}
			</span>
		</>
	);
	if (targets.length < 2)
		return (
			<span className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
				{body}
			</span>
		);
	return (
		<Menu>
			<MenuTrigger
				aria-label={label}
				disabled={disabled}
				className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06]"
			>
				{body}
				<HugeiconsIcon
					icon={ArrowDown01Icon}
					className="ml-auto size-3 shrink-0 text-muted-foreground"
				/>
			</MenuTrigger>
			<MenuPopup align="end" className="min-w-44">
				<MenuRadioGroup
					value={optionKey(target)}
					onValueChange={(key) => {
						const next = targets.find((option) => optionKey(option) === key);
						if (next) onChange(next);
					}}
				>
					{targets.map((option) => (
						<MenuRadioItem
							key={optionKey(option)}
							value={optionKey(option)}
							className="sm:text-xs"
						>
							<span className="flex min-w-0 items-center gap-2">
								<AccountAvatar id={option.id} name={option.name} />
								<span className="truncate">{option.name}</span>
							</span>
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
			</MenuPopup>
		</Menu>
	);
}
