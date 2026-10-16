/** Serialize publication and revocation so late responses cannot escape cleanup.
 * Ports are journaled before issuing requests, including ambiguous failures.
 */
export const createPreviewPublication = (dependencies: {
	readonly publish: (port: number) => Promise<string>;
	readonly revoke: (port?: number) => Promise<unknown>;
	readonly ports: () => readonly number[];
	readonly remember: (port: number) => void;
	readonly forget: (port: number) => void;
	readonly pending: (pending: boolean) => void;
}) => {
	let tail: Promise<unknown> = Promise.resolve();
	let consumers = 0;
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const queue = <T>(work: () => Promise<T>): Promise<T> => {
		const result = tail.catch(() => {}).then(work);
		tail = result;
		return result;
	};
	const revoke = (onlyIfIdle = false): Promise<void> =>
		queue(async () => {
			if (onlyIfIdle && consumers > 0) return;
			clearTimeout(retry);
			dependencies.pending(true);
			const errors: unknown[] = [];
			try {
				await dependencies.revoke();
			} catch (cause) {
				errors.push(cause);
			}
			for (const port of dependencies.ports()) {
				try {
					await dependencies.revoke(port);
					dependencies.forget(port);
				} catch (cause) {
					errors.push(cause);
				}
			}
			if (errors.length > 0) {
				retry = setTimeout(
					() => {
						void revoke().catch(() => {});
					},
					Math.min(60_000, 5000 * 2 ** failures++),
				);
				throw new AggregateError(
					errors,
					"Preview URL revocation is still pending. Previously shared links may remain public.",
				);
			}
			failures = 0;
			dependencies.pending(false);
		});
	return {
		publish: (port: number, enabled: () => boolean): Promise<string> =>
			queue(async () => {
				if (!enabled()) throw new Error("Preview publication is disabled.");
				dependencies.remember(port);
				const url = await dependencies.publish(port);
				if (!enabled()) {
					throw new Error("Preview publication was disabled.");
				}
				return url;
			}),
		revoke,
		retain: () => {
			consumers += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				consumers -= 1;
				if (consumers === 0) void revoke(true).catch(() => {});
			};
		},
	};
};
