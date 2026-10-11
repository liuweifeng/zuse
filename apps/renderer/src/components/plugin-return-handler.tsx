import { useEffect, useState } from "react";
import { useAuth } from "~/hooks/use-auth.ts";
import {
	clearStoredPluginReturn,
	type PluginReturn,
	parsePluginReturn,
	takeUrlPluginReturn,
} from "~/lib/plugin-return.ts";
import { openPluginsPage } from "~/lib/plugins-navigation.ts";
import { toastManager } from "./ui/toast.tsx";

// Tickets are single-use; a duplicate loopback hit or re-render must not
// redeem twice or toast twice.
const seen = new Set<string>();

/**
 * Finishes plugin connections automatically when the browser returns from the
 * provider. No extra confirmation: holding the ticket proves this browser
 * finished consent and the API checks it's the account that started it.
 */
export function PluginReturnHandler() {
	const { isSignedIn } = useAuth();
	const [queue, setQueue] = useState<PluginReturn[]>(() => {
		const initial = takeUrlPluginReturn();
		return initial === null ? [] : [initial];
	});
	useEffect(() => {
		const plugins = window.zuse?.plugins;
		if (plugins === undefined) return;
		const unsubscribe = plugins.onReturn((raw) => {
			const value = parsePluginReturn(raw);
			if (value !== null) setQueue((current) => [...current, value]);
		});
		plugins.subscribeReturns();
		return unsubscribe;
	}, []);
	useEffect(() => {
		if (!isSignedIn || queue.length === 0) return;
		setQueue([]);
		for (const value of queue) {
			const id = value.ticket ?? `${value.tenantId}:${value.error}`;
			if (seen.has(id)) continue;
			seen.add(id);
			// The web app returns on its root; bring the user back to Plugins.
			if (window.zuse === undefined) {
				openPluginsPage();
			}
			// Return capture remains immediate; catalog/RPC redemption is loaded only
			// for an actual callback, never for the ordinary application startup.
			let loaded = false;
			void import("./plugin-return-redemption.ts")
				.then(({ redeemPluginReturn }) => {
					loaded = true;
					clearStoredPluginReturn();
					return redeemPluginReturn(value);
				})
				.catch((cause: unknown) => {
					// A chunk failure has not consumed the one-use ticket. Keep the hosted
					// return in storage for reload and allow native callback redelivery.
					if (!loaded) seen.delete(id);
					toastManager.add({
						type: "error",
						title: cause instanceof Error ? cause.message : String(cause),
					});
				});
		}
	}, [isSignedIn, queue]);
	return null;
}
