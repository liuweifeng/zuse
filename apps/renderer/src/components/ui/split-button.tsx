import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@zuse/icons/stroke-rounded";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Menu, MenuPopup, MenuTrigger } from "./menu.tsx";

const segmentClass =
	"inline-flex items-center justify-center text-foreground outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] disabled:pointer-events-none disabled:opacity-50";

/**
 * Primary action with an attached options menu: one bordered control split by
 * a divider, the label on the left and a chevron that opens `menu`.
 */
export function SplitButton({
	icon,
	label,
	onClick,
	disabled = false,
	menuLabel,
	menu,
	className,
}: {
	icon?: ReactNode;
	label: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	/** Accessible name for the chevron. */
	menuLabel: string;
	menu: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-foreground/10 bg-foreground/[0.03] font-medium text-xs",
				className,
			)}
		>
			<button
				type="button"
				className={cn(segmentClass, "min-w-0 gap-1.5 pr-2 pl-2")}
				disabled={disabled}
				onClick={onClick}
			>
				{icon}
				<span className="truncate">{label}</span>
			</button>
			<Menu>
				<MenuTrigger
					aria-label={menuLabel}
					disabled={disabled}
					className={cn(
						segmentClass,
						"w-6 border-foreground/10 border-l text-muted-foreground hover:text-foreground",
					)}
				>
					<HugeiconsIcon icon={ArrowDown01Icon} className="size-3" />
				</MenuTrigger>
				<MenuPopup align="end" className="min-w-56">
					{menu}
				</MenuPopup>
			</Menu>
		</div>
	);
}
