import { Effect, Exit } from "effect";

/** Startup-only ownership. The returned driver's close method owns resources on success. */
export interface ProviderStartup {
	readonly signal: AbortSignal;
	readonly add: (close: () => void | Promise<void>) => void;
	readonly acquire: <A>(
		open: () => Promise<A>,
		close: (resource: A) => void | Promise<void>,
	) => Promise<A>;
}

const release = async (close: () => void | Promise<void>): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(close),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("cleanup timed out")), 5_000);
			}),
		]);
	} catch {
		console.warn("[agents] Provider startup resource cleanup failed");
	} finally {
		clearTimeout(timer);
	}
};

export const withProviderStartup = <
	A extends { readonly close: () => Effect.Effect<void> },
	E,
	R,
>(
	start: (resources: ProviderStartup) => Effect.fn.Return<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.suspend(() => {
		const abort = new AbortController();
		let transferred = false;
		const cleanups: Array<() => void | Promise<void>> = [];
		const resources: ProviderStartup = {
			signal: abort.signal,
			add: (close) => {
				if (abort.signal.aborted) void release(close);
				else if (!transferred) cleanups.push(close);
			},
			acquire: async (open, close) => {
				abort.signal.throwIfAborted();
				const resource = await open();

				if (abort.signal.aborted) {
					await release(() => close(resource));
					abort.signal.throwIfAborted();
				}
				resources.add(() => close(resource));
				return resource;
			},
		};
		return Effect.gen(() => start(resources)).pipe(
			Effect.onExit((exit) => {
				if (Exit.isSuccess(exit)) {
					transferred = true;
					cleanups.length = 0;
					return Effect.void;
				}
				return Effect.promise(async () => {
					abort.abort();
					await Promise.all(cleanups.splice(0).reverse().map(release));
				});
			}),
		);
	});
