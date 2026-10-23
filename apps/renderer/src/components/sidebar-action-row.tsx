import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Compact navigation row used by the projects sidebar's top sections. */
export function SidebarActionRow({
	icon,
	leading,
	label,
	shortcut,
	trailing,
	title,
	active = false,
	onClick,
}: {
	/** Either a hugeicon or a custom `size-4` leading element. */
	icon?: IconSvgElement;
	leading?: ReactNode;
	label: string;
	shortcut?: string;
	trailing?: ReactNode;
	title?: string;
	active?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex min-h-6 w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[12px] transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				active
					? "bg-sidebar-accent text-sidebar-accent-foreground"
					: "text-muted-foreground",
			)}
		>
			{leading ??
				(icon ? (
					<HugeiconsIcon icon={icon} className="size-4 shrink-0" />
				) : null)}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{shortcut !== undefined && shortcut !== "" ? (
				<kbd className="shrink-0 font-sans text-[12px] text-muted-foreground">
					{shortcut}
				</kbd>
			) : null}
			{trailing}
		</button>
	);
}
