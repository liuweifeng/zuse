import "@zuse/i18n/english/plugins";
import { message } from "@zuse/i18n";
import type { PluginReturn } from "../lib/plugin-return.ts";
import { notifyPluginsChanged, pluginRequest } from "../lib/plugins-client.ts";
import { toastManager } from "./ui/toast.tsx";

export async function redeemPluginReturn(value: PluginReturn) {
	const name = value.plugin ?? message("plugins:plugins_title");
	if (value.ticket === null) {
		toastManager.add({
			title: message("plugins:plugins_return_cancelled", { name }),
			description: message("plugins:plugins_return_cancelled_detail"),
			type: "error",
		});
		return;
	}
	try {
		const result = await pluginRequest({
			action: "complete",
			tenantId: value.tenantId,
			ticket: value.ticket,
		});
		if (result.kind !== "attempt" || result.state !== "connected")
			throw new Error("Connection did not complete");
		toastManager.add({
			title: message("plugins:plugins_connected_toast", { name }),
			description: message("plugins:plugins_connected_toast_detail"),
			type: "success",
		});
	} catch {
		toastManager.add({
			title: message("plugins:plugins_connect_failed", { name }),
			description: message("plugins:plugins_return_failed_detail"),
			type: "error",
		});
	} finally {
		notifyPluginsChanged(value.tenantId);
	}
}
