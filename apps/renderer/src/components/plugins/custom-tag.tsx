import "@zuse/i18n/english/plugins";
import { useMessages } from "@zuse/i18n/react";

/** Marks servers the workspace added by URL. */
export function CustomTag() {
	const { message: m } = useMessages(["plugins"]);
	return (
		<span className="shrink-0 rounded-[4px] bg-muted px-1 py-px text-[10px] font-medium leading-4 text-muted-foreground">
			{m("plugins:plugins_custom")}
		</span>
	);
}
