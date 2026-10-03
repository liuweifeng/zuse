import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tryAcquireProcessLock } from "@zuse/sqlite";

export interface EngineSupervisionOptions {
	readonly userData: string;
	readonly spawnWorker: () => ChildProcess;
	readonly signal: AbortSignal;
	readonly log: (message: string) => void;
	readonly restartDelayMs?: number;
	readonly stableMs?: number;
	readonly maxRapidFailures?: number;
	readonly shutdownGraceMs?: number;
}

/** One supervisor per data directory. Worker crashes are reclaimed; desktop disconnect is irrelevant. */
export const superviseEngine = async (
	options: EngineSupervisionOptions,
): Promise<void> => {
	const directory = join(options.userData, "engine");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const owner = tryAcquireProcessLock(
		join(directory, "supervisor.lock.sqlite"),
	);
	if (owner === null) return;
	try {
		let rapidFailures = 0;
		while (!options.signal.aborted) {
			const startedAt = performance.now();
			const child = options.spawnWorker();
			child.stdout?.on("data", (data) => options.log(String(data)));
			child.stderr?.on("data", (data) => options.log(String(data)));
			const outcome = await new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
			}>((resolve) => {
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				let done = false;
				const finish = (code: number | null, signal: NodeJS.Signals | null) => {
					if (done) return;
					done = true;
					clearTimeout(killTimer);
					options.signal.removeEventListener("abort", stop);
					child.off("exit", finish);
					child.off("error", failed);
					resolve({ code, signal });
				};
				const stop = () => {
					child.kill("SIGTERM");
					killTimer ??= setTimeout(
						() => child.kill("SIGKILL"),
						options.shutdownGraceMs ?? 5_000,
					);
				};
				const failed = () => finish(127, null);
				child.once("exit", finish);
				child.once("error", failed);
				options.signal.addEventListener("abort", stop, { once: true });
				if (options.signal.aborted) stop();
			});
			if (options.signal.aborted || outcome.code === 0) return;
			rapidFailures =
				performance.now() - startedAt >= (options.stableMs ?? 60_000)
					? 1
					: rapidFailures + 1;
			options.log(
				`Engine worker exited (${outcome.code ?? outcome.signal}); recovery attempt ${rapidFailures}.\n`,
			);
			if (rapidFailures >= (options.maxRapidFailures ?? 5))
				throw new Error(
					"The engine repeatedly failed to start. Inspect the engine runtime log before retrying.",
				);
			await delay(
				Math.min(
					5_000,
					(options.restartDelayMs ?? 250) * 2 ** (rapidFailures - 1),
				),
				undefined,
				{ signal: options.signal },
			).catch((error) => {
				if (!options.signal.aborted) throw error;
			});
		}
	} finally {
		owner.release();
	}
};

export { readDesktopEngineConfig } from "./config.ts";
