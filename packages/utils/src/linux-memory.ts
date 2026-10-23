/** Linux cache is reclaimable: MemAvailable, not MemFree, measures headroom. */
export const linuxMemory = (text: string) => {
	const field = (name: string): number | undefined => {
		const match = text.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m"));
		return match ? Number(match[1]) * 1024 : undefined;
	};
	const total = field("MemTotal");
	const available = field("MemAvailable");
	if (
		total === undefined ||
		total <= 0 ||
		available === undefined ||
		available > total
	)
		return null;
	return {
		total,
		available,
		used: total - available,

		pressure: available < Math.min(total * 0.1, 512 * 1024 * 1024),
	};
};

export const linuxOomKills = (text: string): number | undefined => {
	const match = text.match(/^oom_kill\s+(\d+)$/m);
	return match ? Number(match[1]) : undefined;
};

export const RUNTIME_MEMORY_BASELINE_PATH =
	"/var/lib/zuse/workspace/runtime-memory.json";

/** A counter from another boot or runtime generation cannot diagnose this disconnect. */
export const hasNewOomKill = (
	baselineJson: string,
	bootId: string,
	vmstat: string,
	generation: unknown,
): boolean => {
	try {
		const baseline = JSON.parse(baselineJson);
		const count = linuxOomKills(vmstat);
		const expectedGeneration = Number(generation);
		return (
			Number.isSafeInteger(expectedGeneration) &&
			expectedGeneration > 0 &&
			Number(baseline.generation) === expectedGeneration &&
			typeof baseline.oomKills === "number" &&
			baseline.oomKills >= 0 &&
			typeof baseline.bootId === "string" &&
			baseline.bootId.length > 0 &&
			baseline.bootId === bootId.trim() &&
			count !== undefined &&
			count > baseline.oomKills
		);
	} catch {
		return false;
	}
};
