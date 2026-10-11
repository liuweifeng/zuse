import "@zuse/i18n/english/plugins";
import type { PluginConnection, PluginSnapshot } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { useCallback, useEffect, useState } from "react";
import { toastManager } from "~/components/ui/toast.tsx";
import { notifyPluginsChanged, pluginRequest } from "~/lib/plugins-client.ts";

export type PluginConnectionToggle = {
	/** False for organization members: switches render read-only. */
	readonly canToggle: boolean;
	readonly enabled: (connection: PluginConnection) => boolean;
	readonly busy: (connectionId: string) => boolean;
	readonly toggle: (
		connection: PluginConnection,
		name: string,
		enabled: boolean,
	) => Promise<void>;
};

/**
 * Turns a connection's tools on or off for agents, with optimistic switch
 * state until the refreshed snapshot lands. Shared by every plugin switch.
 */
export function usePluginConnectionToggle(
	snapshot: PluginSnapshot | null,
): PluginConnectionToggle {
	const { message: m } = useMessages(["plugins"]);
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
		new Map(),
	);
	// A fresh snapshot is authoritative again.
	useEffect(() => setOverrides(new Map()), [snapshot]);
	const tenantId = snapshot?.tenantId ?? null;

	const toggle = useCallback(
		async (connection: PluginConnection, name: string, enabled: boolean) => {
			if (tenantId === null) return;
			const id = connection.id;
			setPending((current) => new Set(current).add(id));
			setOverrides((current) => new Map(current).set(id, enabled));
			try {
				await pluginRequest({
					action: "setEnabled",
					tenantId,
					connectionId: id,
					enabled,
				});
				notifyPluginsChanged(tenantId);
			} catch {
				setOverrides((current) => {
					const next = new Map(current);
					next.delete(id);
					return next;
				});
				toastManager.add({
					title: m("plugins:plugins_settings_toggle_failed", { name }),
					type: "error",
				});
			} finally {
				setPending((current) => {
					const next = new Set(current);
					next.delete(id);
					return next;
				});
			}
		},
		[m, tenantId],
	);

	return {
		canToggle: snapshot?.canManage === true,
		enabled: (connection) => overrides.get(connection.id) ?? connection.enabled,
		busy: (connectionId) => pending.has(connectionId),
		toggle,
	};
}
