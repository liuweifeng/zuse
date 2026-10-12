import { describe, expect, it } from "vitest";
import {
	ditherCellAlpha,
	type PaintOpts,
} from "../../src/components/dither-kit/dither-paint.ts";

const options: PaintOpts = {
	variant: "gradient",
	intensity: 0,
	dim: 1,
	stacked: false,
};
const samples = (depth: number, overrides: Partial<PaintOpts> = {}) =>
	Array.from({ length: 16 }, (_, i) =>
		ditherCellAlpha(i % 4, Math.floor(i / 4), depth, {
			...options,
			...overrides,
		}),
	);
const mean = (values: number[]) =>
	values.reduce((sum, value) => sum + value, 0) / values.length;

describe("shared chart scatter", () => {
	it("fades toward the value edge and becomes denser toward the floor", () => {
		expect(mean(samples(0))).toBeLessThan(mean(samples(0.5)));
		expect(mean(samples(0.5))).toBeLessThan(mean(samples(1)));
		expect(samples(1)).toEqual(Array(16).fill(1));
	});
	it("keeps dotted gaps, a solid variant, and bounded hover opacity", () => {
		expect(samples(0.1, { variant: "dotted" })).toContain(0);
		expect(new Set(samples(0.5, { variant: "solid" })).size).toBe(1);
		for (const depth of [0, 0.5, 1]) {
			for (const alpha of samples(depth, { intensity: 1 })) {
				expect(alpha).toBeGreaterThanOrEqual(0);
				expect(alpha).toBeLessThanOrEqual(1);
			}
		}
	});
	it("preserves dimming and the denser stacked fill", () => {
		expect(mean(samples(0.5, { dim: 0.3 }))).toBeCloseTo(
			mean(samples(0.5)) * 0.3,
		);
		expect(mean(samples(0.1, { stacked: true }))).toBeGreaterThan(
			mean(samples(0.1)),
		);
	});
});
