import type { PluginConnection } from "@zuse/contracts";
import type { PluginConnectionToggle } from "~/hooks/use-plugin-connection-toggle.ts";
import { Switch } from "../ui/switch.tsx";

/** On/off for one connection's tools; read-only for organization members. */
export function PluginConnectionSwitch({
	connection,
	name,
	toggle,
}: {
	readonly connection: PluginConnection;
	readonly name: string;
	readonly toggle: PluginConnectionToggle;
}) {
	return (
		<Switch
			checked={toggle.enabled(connection)}
			disabled={!toggle.canToggle || toggle.busy(connection.id)}
			aria-label={name}
			onCheckedChange={(next) => void toggle.toggle(connection, name, next)}
		/>
	);
}
