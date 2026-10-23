import { readFile, rename, statfs, writeFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { MachineResourceSample } from "@zuse/contracts";
import {
	linuxMemory,
	linuxOomKills,
	RUNTIME_MEMORY_BASELINE_PATH,
} from "@zuse/utils/linux-memory";
import { Context, Duration, Effect, Layer, Schedule, Stream } from "effect";

const MIN_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 30_000;
const DEFAULT_INTERVAL_MS = 5_000;

export interface CpuCounters {
	readonly idle: number;
	readonly total: number;
	readonly cores: number;
}

export interface ResourceSnapshot {
	readonly sampledAt: number;
	readonly counters: CpuCounters;
	readonly memTotalBytes: number;
	readonly memUsedBytes: number;
	readonly memoryPressure?: boolean;
	readonly diskTotalBytes: number;
	readonly diskUsedBytes: number;
	readonly diskPath: string;
}

const cpuCountersFromOs = (): CpuCounters => {
	const all = cpus();
	let idle = 0;
	let total = 0;
	for (const cpu of all) {
		idle += cpu.times.idle;
		total +=
			cpu.times.user +
			cpu.times.nice +
			cpu.times.sys +
			cpu.times.idle +
			cpu.times.irq;
	}
	return { idle, total, cores: Math.max(all.length, 1) };
};

const readSnapshot = Effect.promise(async (): Promise<ResourceSnapshot> => {
	const memory =
		process.platform === "linux"
			? linuxMemory(await readFile("/proc/meminfo", "utf8").catch(() => ""))
			: null;
	const memTotalBytes = memory?.total ?? totalmem();
	const diskPath = process.cwd();
	const disk = await statfs(diskPath).catch(() => null);
	const diskTotalBytes = disk === null ? 0 : disk.bsize * disk.blocks;
	const diskUsedBytes =
		disk === null ? 0 : disk.bsize * Math.max(disk.blocks - disk.bfree, 0);
	return {
		sampledAt: Date.now(),
		counters: cpuCountersFromOs(),
		memTotalBytes,
		memUsedBytes: memory?.used ?? Math.max(memTotalBytes - freemem(), 0),
		memoryPressure: memory?.pressure,
		diskTotalBytes,
		diskUsedBytes,
		diskPath,
	};
});

export const toSample = (
	previous: CpuCounters | undefined,
	snapshot: ResourceSnapshot,
): MachineResourceSample => {
	const idleDelta = snapshot.counters.idle - (previous?.idle ?? 0);
	const totalDelta = snapshot.counters.total - (previous?.total ?? 0);
	const busyRatio = totalDelta > 0 ? (totalDelta - idleDelta) / totalDelta : 0;
	return MachineResourceSample.make({
		sampledAt: snapshot.sampledAt,
		cpuCores: snapshot.counters.cores,
		cpuPercent: Math.min(Math.max(busyRatio * 100, 0), 100),
		memTotalBytes: snapshot.memTotalBytes,
		memUsedBytes: snapshot.memUsedBytes,
		memoryPressure: snapshot.memoryPressure,
		diskTotalBytes: snapshot.diskTotalBytes,
		diskUsedBytes: snapshot.diskUsedBytes,
		diskPath: snapshot.diskPath,
	});
};

interface SampleState {
	readonly counters: CpuCounters | undefined;
	readonly pressureSamples: number;
}

export const accumulateResourceSample = (
	previous: SampleState,
	snapshot: ResourceSnapshot,
): [SampleState, MachineResourceSample[]] => {
	const pressureSamples = snapshot.memoryPressure
		? Math.min(previous.pressureSamples + 1, 3)
		: 0;
	return [
		{ counters: snapshot.counters, pressureSamples },
		[
			toSample(previous.counters, {
				...snapshot,
				memoryPressure:
					snapshot.memoryPressure === undefined
						? undefined
						: pressureSamples >= 3,
			}),
		],
	];
};

export interface MachineResourceServiceShape {
	readonly watch: (intervalMs?: number) => Stream.Stream<MachineResourceSample>;
}

export class MachineResourceService extends Context.Service<
	MachineResourceService,
	MachineResourceServiceShape
>()("zuse/MachineResourceService") {}

const recordMemoryBaseline = async () => {
	if (
		process.env.ZUSE_RUNTIME_KIND !== "cloud-workspace" ||
		process.platform !== "linux"
	)
		return;
	try {
		const [bootId, vmstat] = await Promise.all([
			readFile("/proc/sys/kernel/random/boot_id", "utf8"),
			readFile("/proc/vmstat", "utf8"),
		]);
		const oomKills = linuxOomKills(vmstat);
		if (oomKills === undefined) return;
		const temporary = `${RUNTIME_MEMORY_BASELINE_PATH}.${process.pid}.tmp`;
		await writeFile(
			temporary,
			JSON.stringify({
				bootId: bootId.trim(),
				oomKills,
				generation: process.env.ZUSE_RUNTIME_GENERATION,
			}),
			{ mode: 0o600 },
		);
		await rename(temporary, RUNTIME_MEMORY_BASELINE_PATH);
	} catch {}
};

export const MachineResourceServiceLive = Layer.effect(
	MachineResourceService,
	Effect.promise(recordMemoryBaseline).pipe(
		Effect.map(() =>
			MachineResourceService.of({
				watch: (intervalMs) => {
					const interval = Math.min(
						Math.max(intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS),
						MAX_INTERVAL_MS,
					);
					return Stream.fromEffect(readSnapshot).pipe(
						Stream.repeat(Schedule.spaced(Duration.millis(interval))),
						Stream.mapAccum(
							() => ({
								counters: undefined as CpuCounters | undefined,
								pressureSamples: 0,
							}),
							accumulateResourceSample,
						),
					);
				},
			}),
		),
	),
);
