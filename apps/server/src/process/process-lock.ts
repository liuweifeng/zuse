import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { tryAcquireProcessLock } from "@zuse/sqlite";
import { Effect } from "effect";

export interface ProcessLock {
	readonly close: () => void;
}

export class ProcessLockError extends Error {
	constructor(
		readonly kind: "timeout" | "unavailable",
		cause?: unknown,
	) {
		super(
			kind === "timeout"
				? "Timed out waiting for process lock"
				: "Failed to acquire process lock",
			{ cause },
		);
	}
}

/** OS-backed mutex released on process death. Never unlink or replace its inode. */
export const acquireProcessLock = (
	path: string,
	attempts = 140,
): Effect.Effect<ProcessLock, Error> =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const lock = yield* Effect.try({
				try: () => tryAcquireProcessLock(path),
				catch: (cause) => new ProcessLockError("unavailable", cause),
			});
			if (lock !== null) return { close: lock.release };
			yield* Effect.sleep("150 millis");
		}
		return yield* Effect.fail(new ProcessLockError("timeout"));
	});

/** Acquire and release with one owner; credential callers can await this safely. */
export async function withProcessLock<T>(
	path: string,
	operation: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const lock = await Effect.runPromise(acquireProcessLock(path), { signal });
	try {
		signal?.throwIfAborted();
		return await operation();
	} finally {
		lock.close();
	}
}
