import { describe, expect, test } from "vitest";

import {
	accumulateResourceSample,
	type ResourceSnapshot,
	toSample,
} from "../../src/machine/machine-resource-service.ts";

const snapshot = (
	counters: ResourceSnapshot["counters"],
): ResourceSnapshot => ({
	sampledAt: 1_000,
	counters,
	memTotalBytes: 16_384_000 * 1024,
	memUsedBytes: 4_096_000 * 1024,
	diskTotalBytes: 100_000_000,
	diskUsedBytes: 36_000_000,
	diskPath: "/home/zuse/workspace",
});

describe("machine resource sampling", () => {
	test("computes busy percentage from consecutive counter deltas", () => {
		const first = toSample(
			undefined,
			snapshot({ idle: 7000, total: 10_000, cores: 8 }),
		);
		expect(first.cpuPercent).toBeCloseTo(30);
		expect(first.cpuCores).toBe(8);

		const second = toSample(
			{ idle: 7000, total: 10_000, cores: 8 },
			snapshot({ idle: 7900, total: 11_000, cores: 8 }),
		);
		expect(second.cpuPercent).toBeCloseTo(10);
		expect(second.memUsedBytes).toBe(4_096_000 * 1024);
		expect(second.diskTotalBytes).toBe(100_000_000);
	});

	test("clamps percentage when counters go backwards", () => {
		const sample = toSample(
			{ idle: 8000, total: 12_000, cores: 8 },
			snapshot({ idle: 7000, total: 11_000, cores: 8 }),
		);
		expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
		expect(sample.cpuPercent).toBeLessThanOrEqual(100);
	});
});

test("warns after sustained pressure and clears immediately when memory recovers", () => {
	let state = {
		counters: undefined as ResourceSnapshot["counters"] | undefined,
		pressureSamples: 0,
	};
	for (const [pressure, expected] of [
		[true, false],
		[true, false],
		[true, true],
		[false, false],
		[true, false],
	] as const) {
		const [next, samples] = accumulateResourceSample(state, {
			...snapshot({ idle: 1, total: 2, cores: 2 }),
			memoryPressure: pressure,
		});
		state = next;
		expect(samples[0]?.memoryPressure).toBe(expected);
	}
	expect(
		accumulateResourceSample(
			state,
			snapshot({ idle: 1, total: 2, cores: 2 }),
		)[1][0]?.memoryPressure,
	).toBeUndefined();
});
