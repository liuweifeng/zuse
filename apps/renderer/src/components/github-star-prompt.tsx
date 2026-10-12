import { HugeiconsIcon } from "@hugeicons/react";
import "@zuse/i18n/english/projects";
import { useMessages } from "@zuse/i18n/react";
import { StarIcon } from "@zuse/icons/solid-rounded";
import { Cancel01Icon } from "@zuse/icons/stroke-rounded";
import { useOrganizationAction } from "../hooks/use-organization-action.ts";
import {
	updateBrowserDevicePreferences,
	useBrowserDevicePreferences,
} from "../lib/browser-device-preferences.ts";
import { runControlPlane } from "../lib/control-plane-client.ts";
import { openExternal } from "../lib/platform-capabilities.ts";
import { Spinner } from "./ui/spinner.tsx";
import { toastManager } from "./ui/toast.tsx";

const zuseRepositoryUrl = "https://github.com/swarajbachu/zuse";

/** Stars with this computer's GitHub sign-in, or opens the repository to star there. */
export function GithubStarPrompt() {
	const { message } = useMessages(["common", "projects"]);
	const { busy, run } = useOrganizationAction();
	const dismissed = useBrowserDevicePreferences(
		(preferences) => preferences.githubStarPromptDismissed === true,
	);
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
				// Without a usable local sign-in, star it on GitHub instead.
				await runControlPlane((client) => client["git.starZuse"]()).catch(() =>
					openExternal("https://github.com/swarajbachu/zuse"),
				);
				if (current()) dismiss();
			} catch {
				if (current())
					toastManager.add({
						type: "error",
						title: message("projects:projects_sidebar_github_open_failed"),
					});
			}
		});
	if (dismissed) return null;

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
