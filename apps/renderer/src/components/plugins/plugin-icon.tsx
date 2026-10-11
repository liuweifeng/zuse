import { useState } from "react";
import { pluginIconUrl } from "~/lib/connected-plugins.ts";
import { cn } from "~/lib/utils";

export function PluginIcon({
	name,
	domain,
	className,
}: {
	readonly name: string;
	readonly domain: string;
	readonly className?: string;
}) {
	const [state, setState] = useState<"loading" | "loaded" | "failed">(
		"loading",
	);
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-muted text-[13px] font-medium text-muted-foreground ring-1 ring-inset ring-foreground/5",
				className,
			)}
		>
			{/* The initial shows until the logo loads, so the slot is never blank. */}
			{state !== "loaded" && name.slice(0, 1).toUpperCase()}
			{state !== "failed" && domain.length > 0 && (
				<img
					src={pluginIconUrl(domain)}
					alt=""
					loading="lazy"
					decoding="async"
					referrerPolicy="no-referrer"
					className={cn(
						"size-full object-cover",
						state === "loading" && "absolute inset-0 opacity-0",
					)}
					onLoad={() => setState("loaded")}
					onError={() => setState("failed")}
				/>
			)}
		</span>
	);
}
