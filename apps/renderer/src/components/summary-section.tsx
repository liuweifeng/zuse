import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { ArrowDown01Icon } from "@zuse/icons/solid-rounded";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils.ts";
import { summaryMetaClass, summaryRowClass } from "./cloud-workspace-info.tsx";

/**
 * A collapsible group in the environment summary: an ordinary icon row whose
 * chevron folds the rows beneath it.
 */
export function SummarySection({
	icon,
	label,
	meta,
	defaultOpen = true,
	children,
}: {
	readonly icon: IconSvgElement;
	readonly label: string;
	readonly meta?: ReactNode;
	readonly defaultOpen?: boolean;
	readonly children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<section aria-label={label}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className={`${summaryRowClass} hover:bg-muted/60`}
			>
				<HugeiconsIcon
					icon={icon}
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="min-w-0 flex-1 truncate">{label}</span>
				<span className={summaryMetaClass}>
					{meta}
					<HugeiconsIcon
						icon={ArrowDown01Icon}
						className={cn(
							"size-3 transition-transform motion-reduce:transition-none",
							!open && "-rotate-90",
						)}
					/>
				</span>
			</button>
			{open ? children : null}
		</section>
	);
}
