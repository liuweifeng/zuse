import { HugeiconsIcon } from "@hugeicons/react";
import "@zuse/i18n/english/projects";
import { useMessages } from "@zuse/i18n/react";
import { StarIcon } from "@zuse/icons/solid-rounded";
import { Cancel01Icon } from "@zuse/icons/stroke-rounded";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useOrganizationAction } from "../hooks/use-organization-action.ts";
import {
	updateBrowserDevicePreferences,
	useBrowserDevicePreferences,
} from "../lib/browser-device-preferences.ts";
import { runControlPlane } from "../lib/control-plane-client.ts";
import {
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "../lib/renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "../lib/renderer-workspace.ts";
import { Spinner } from "./ui/spinner.tsx";
import { toastManager } from "./ui/toast.tsx";

/** Stars directly with this computer's GitHub sign-in. */
export function GithubStarPrompt() {
	const { message } = useMessages(["common", "projects"]);
	const { busy, run } = useOrganizationAction();
	const dismissed = useBrowserDevicePreferences(
		(preferences) => preferences.githubStarPromptDismissed === true,
	);
	const account = useSyncExternalStore(
		subscribeRendererAccount,
		rendererAccountSnapshot,
		rendererAccountSnapshot,
	);
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	const [status, setStatus] = useState<{
		account: typeof account;
		workspace: typeof workspace;
		starred: boolean;
	} | null>(null);
	useEffect(() => {
		if (dismissed) return;
		let live = true;
		void runControlPlane((client) => client["git.zuseStarStatus"]())
			.then((starred) => {
				if (
					live &&
					account === rendererAccountSnapshot() &&
					workspace === rendererWorkspaceSnapshot()
				)
					setStatus({ account, workspace, starred });
			})
			.catch(() => {
				// Keep the prompt hidden when GitHub status cannot be verified.
			});
		return () => {
			live = false;
		};
	}, [account, workspace, dismissed]);
	const dismiss = () => {
		try {
			updateBrowserDevicePreferences({ githubStarPromptDismissed: true });
		} catch {
			toastManager.add({
				type: "error",
				title: message("common:device_preferences_save_failed"),
			});
		}
	};
	const star = () =>
		run(async (current) => {
			try {
				await runControlPlane((client) => client["git.starZuse"]());
				if (current()) dismiss();
			} catch {
				// Starring is optional; leave the prompt available for a silent retry.
			}
		});
	if (
		dismissed ||
		status?.account !== account ||
		status.workspace !== workspace ||
		status.starred
	)
		return null;

	return (
		<div className="group/star relative mx-2 mb-1 shrink-0">
			<button
				type="button"
				className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-7 pl-2 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
				disabled={busy}
				aria-busy={busy}
				onClick={() => void star()}
			>
				{busy ? (
					<Spinner className="size-3.5 shrink-0" />
				) : (
					<HugeiconsIcon
						icon={StarIcon}
						className="size-3.5 shrink-0 transition-colors group-hover/star:fill-current group-hover/star:text-amber-500"
						aria-hidden="true"
					/>
				)}
				<span className="truncate">
					{message(
						busy
							? "projects:projects_sidebar_github_starring"
							: "projects:projects_sidebar_star_on_github",
					)}
				</span>
			</button>
			<button
				type="button"
				aria-label={message("projects:projects_sidebar_dismiss_star_prompt")}
				className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-focus-within/star:opacity-100 group-hover/star:opacity-100"
				onClick={dismiss}
			>
				<HugeiconsIcon
					icon={Cancel01Icon}
					className="size-3"
					aria-hidden="true"
				/>
			</button>
		</div>
	);
}
