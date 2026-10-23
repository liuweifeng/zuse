import {
	MASTER_MASCOT_COLORS,
	MASTER_MASCOTS,
	type Master,
	type MasterAvatar,
} from "@zuse/contracts";
import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";
import { fnv1a } from "../../lib/fnv1a.ts";
import { MASCOT_SPRITES } from "./mascot-sprites.ts";

/** What the Master is doing; each state is a sprite frame plus a motion. */
export type MascotState = "idle" | "working" | "attention" | "paused";

/** [body, dithered shade] per palette slot. */
export const MASCOT_PALETTE: Readonly<
	Record<MasterAvatar["color"], readonly [string, string]>
> = {
	coral: ["#ef6b5f", "#c94a45"],
	yellow: ["#f6c94a", "#e0a92c"],
	green: ["#7fd05a", "#5aae3c"],
	lime: ["#c3e45a", "#9ec43a"],
	violet: ["#a98bf5", "#8263dc"],
	teal: ["#5fd0c0", "#36ab9c"],
	blue: ["#6ea8ff", "#4b82e0"],
	pink: ["#ff8fbf", "#e2669c"],
};
const FIXED: Readonly<Record<string, string>> = {
	k: "#1d1418",
	w: "#ffffff",
	h: "#9b4a2c",
	f: "#a0602f",
	t: "#ff7aa8",
};

const avatarFromNumber = (value: number): MasterAvatar => ({
	mascot: MASTER_MASCOTS[value % MASTER_MASCOTS.length] ?? "daemon",
	color:
		MASTER_MASCOT_COLORS[(value >>> 8) % MASTER_MASCOT_COLORS.length] ??
		"coral",
});

/** The saved avatar, or a stable one derived from the id for older Masters. */
export const avatarFor = (
	master: Pick<Master, "id" | "settings">,
): MasterAvatar => master.settings.avatar ?? avatarFromNumber(fnv1a(master.id));

export const randomAvatar = (): MasterAvatar =>
	avatarFromNumber(Math.floor(Math.random() * 2 ** 31));

/** One `path` per colour key, merging horizontal runs (like dither-cloud.ts). */
const pathsCache = new WeakMap<readonly string[], Record<string, string>>();
const toPaths = (rows: readonly string[]) => {
	const cached = pathsCache.get(rows);
	if (cached) return cached;
	const paths: Record<string, string> = {};
	rows.forEach((row, y) => {
		let x = 0;
		while (x < row.length) {
			const key = row[x] ?? ".";
			let end = x;
			while (row[end + 1] === key) end++;
			const width = end - x + 1;
			if (key !== ".")
				paths[key] = `${paths[key] ?? ""}M${x} ${y}h${width}v1h-${width}z`;
			x = end + 1;
		}
	});
	pathsCache.set(rows, paths);
	return paths;
};

const FRAMES = ["open", "closed"] as const;

/**
 * A pixel Master. Frames swap with stepped CSS animations (see `.mascot-sprite`
 * in styles.css), so idle Masters blink and bob a pixel without React work.
 */
export function Mascot({
	avatar,
	state = "idle",
	size = "small",
	px,
	seed = "",
	label,
	className,
}: {
	readonly avatar: MasterAvatar;
	readonly state?: MascotState;
	readonly size?: "small" | "large";
	/** Rendered width in CSS pixels; defaults to one CSS pixel per sprite pixel. */
	readonly px?: number;
	/** Staggers blinks so a list of Masters never blinks in unison. */
	readonly seed?: string;
	readonly label?: string;
	readonly className?: string;
}) {
	const sprite = MASCOT_SPRITES[avatar.mascot][size];
	const n = sprite.open.length;
	const width = px ?? n;
	const [body, shade] = MASCOT_PALETTE[avatar.color];
	const fill = (key: string) =>
		key === "b" ? body : key === "s" ? shade : (FIXED[key] ?? body);
	const shadow =
		size === "large"
			? Array.from({ length: Math.round(n / 2) }, (_, index) =>
					index % 2 ? null : (
						<rect
							key={index}
							x={Math.round(n / 4) + index}
							y={n}
							width={1}
							height={1}
							fill="#000"
							opacity={0.4}
						/>
					),
				)
			: null;
	return (
		<svg
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			viewBox={`0 -1 ${n} ${n + 2}`}
			width={width}
			height={(width * (n + 2)) / n}
			data-state={state}
			className={cn("mascot-sprite shrink-0", className)}
			style={
				{
					"--mascot-delay": `-${(fnv1a(seed) % 4600) / 1000}s`,
				} as CSSProperties
			}
		>
			{shadow}
			<g data-part="figure">
				{FRAMES.map((frame) => (
					<g key={frame} data-frame={frame}>
						{Object.entries(toPaths(sprite[frame])).map(([key, d]) => (
							<path key={key} d={d} fill={fill(key)} />
						))}
					</g>
				))}
			</g>
			{state === "attention" ? (
				size === "large" ? (
					<g>
						<rect x={n - 6} y={0} width={5} height={6} fill="#ffd35c" />
						<rect x={n - 4} y={1} width={1} height={2} fill={FIXED.k} />
						<rect x={n - 4} y={4} width={1} height={1} fill={FIXED.k} />
					</g>
				) : (
					<rect x={n - 3} y={0} width={3} height={3} fill="#ffd35c" />
				)
			) : null}
			{state === "paused" && size === "large" ? (
				<path
					data-part="snore"
					d={`M${n - 6} 1h3v1h-1v1h-1v1h2v1h-3v-1h1v-1h1v-1h-2z`}
					fill="currentColor"
					opacity={0.6}
				/>
			) : null}
		</svg>
	);
}
