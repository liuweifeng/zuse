import type { PluginAttempt } from "@zuse/contracts";
import {
	openExternal,
	rendererPlatformCapabilities,
} from "~/lib/platform-capabilities.ts";
import { useUiStore } from "~/store/ui.ts";

/** What the Plugins page should show once it opens. */
export type PluginsPageFocus =
	| { readonly kind: "plugin"; readonly pluginId: string }
	| {
			readonly kind: "attempt";
			readonly attempt: PluginAttempt;
			/** Shown while the snapshot doesn't list a just-added server yet. */
			readonly name: string;
	  };

let pending: PluginsPageFocus | null = null;
const listeners = new Set<() => void>();

/** Opens the Plugins page from anywhere, optionally on a plugin or a pending sign-in. */
export function openPluginsPage(focus?: PluginsPageFocus) {
	if (focus !== undefined) {
		pending = focus;
		for (const listener of listeners) listener();
	}
	const ui = useUiStore.getState();
	ui.setView("chat");
	ui.setActiveMainTab("plugins");
}

/** Takes the focus requested by `openPluginsPage`, at most once. */
export function takePluginsPageFocus(): PluginsPageFocus | null {
	const focus = pending;
	pending = null;
	return focus;
}

/** Lets a mounted Plugins page react to a focus request. */
export function subscribePluginsPageFocus(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Desktop opens the system browser; the web app hands its own tab over. */
export async function openPluginAuthorization(url: string) {
	if (rendererPlatformCapabilities().desktop) await openExternal(url);
	else window.location.assign(url);
}
