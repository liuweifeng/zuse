import { useEffect, useRef } from "react";
import {
	BORDER_ALPHA,
	backingSize,
	ditherCellAlpha,
	type PaintOpts,
	paintColumn,
} from "./dither-paint";
import { type DitherColor, PALETTE, rgb } from "./palette";
import { useChartDimensions } from "./use-chart-dimensions";

export const DONUT_COLORS = [
	"blue",
	"orange",
	"green",
	"purple",
	"pink",
	"red",
] as const;
const paintOptions: PaintOpts = {
	variant: "gradient",
	intensity: 0,
	dim: 1,
	stacked: false,
};

type FillProps =
	| {
			readonly shape: "bar";
			readonly start: number;
			readonly fraction: number;
			readonly color: DitherColor;
	  }
	| { readonly shape: "donut"; readonly values: ReadonlyArray<number> };

/** Paint only when the size or data changes, using the same scatter as Line/Area. */
export function StaticDitherFill(props: FillProps) {
	const { ref, size } = useChartDimensions<HTMLDivElement>();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const { cols, rows } = backingSize(size.width, size.height);
	const start = props.shape === "bar" ? props.start : 0;
	const fraction = props.shape === "bar" ? props.fraction : 0;
	const color = props.shape === "bar" ? props.color : "blue";
	const values = props.shape === "donut" ? props.values : undefined;
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || size.width === 0 || size.height === 0) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		canvas.width = cols;
		canvas.height = rows;
		if (values === undefined) {
			const left = Math.round(start * cols);
			const right = Math.round((start + fraction) * cols);
			for (let x = left; x < right; x++)
				paintColumn(ctx, x, 0, rows, PALETTE[color], paintOptions);
			return;
		}
		const total = values.reduce((sum, value) => sum + value, 0);
		if (total === 0) return;
		let cumulative = 0;
		const ends = values.map((value) => {
			cumulative += value / total;
			return cumulative;
		});
		const radius = Math.min(cols, rows);
		const outer = (radius * 56) / 120;
		const inner = (radius * 44) / 120;
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				const dx = x + 0.5 - cols / 2;
				const dy = y + 0.5 - rows / 2;
				const distance = Math.hypot(dx, dy);
				if (distance < inner || distance > outer) continue;
				const angle =
					((Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)) /
					(Math.PI * 2);
				const index = ends.findIndex((end) => angle < end);
				const seed =
					PALETTE[
						DONUT_COLORS[Math.max(0, index) % DONUT_COLORS.length] ?? "blue"
					];
				const depth = outer - distance;
				const alpha =
					depth < 1
						? BORDER_ALPHA
						: ditherCellAlpha(x, y, depth / (outer - inner), paintOptions);
				ctx.fillStyle = rgb(seed.fill, 1, alpha);
				ctx.fillRect(x, y, 1, 1);
			}
		}
	}, [cols, rows, size.width, size.height, start, fraction, color, values]);
	return (
		<div
			ref={ref}
			aria-hidden="true"
			className="pointer-events-none absolute inset-0"
		>
			<canvas
				ref={canvasRef}
				className="size-full"
				style={{ imageRendering: "pixelated" }}
			/>
		</div>
	);
}
