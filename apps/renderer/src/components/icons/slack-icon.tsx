import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

const SLACK_MARK = [
	{
		color: "#E01E5A",
		d: "M26.4 78.2c0 7.1-5.8 12.9-12.9 12.9S.6 85.3.6 78.2s5.8-12.9 12.9-12.9h12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9z",
	},
	{
		color: "#36C5F0",
		d: "M45.8 26.4c-7.1 0-12.9-5.8-12.9-12.9S38.7.6 45.8.6s12.9 5.8 12.9 12.9v12.9zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H13.5C6.4 58.7.6 52.9.6 45.8s5.8-12.9 12.9-12.9z",
	},
	{
		color: "#2EB67D",
		d: "M97.6 45.8c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97.6zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V13.5C65.3 6.4 71.1.6 78.2.6s12.9 5.8 12.9 12.9z",
	},
	{
		color: "#ECB22E",
		d: "M78.2 97.6c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97.6zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9z",
	},
] as const;

/**
 * Slack brand mark, inlined like the provider marks. Full colour by default;
 * `monochrome` tints it with `currentColor` for muted sidebar indicators.
 */
export function SlackIcon({
	className,
	monochrome = false,
	...props
}: SVGProps<SVGSVGElement> & { readonly monochrome?: boolean }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 124 124"
			className={cn("size-3.5 shrink-0", className)}
			aria-hidden="true"
			{...props}
		>
			{SLACK_MARK.map((part) => (
				<path
					key={part.color}
					d={part.d}
					fill={monochrome ? "currentColor" : part.color}
				/>
			))}
		</svg>
	);
}
