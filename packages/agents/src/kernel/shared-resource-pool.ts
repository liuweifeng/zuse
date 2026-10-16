export interface CloseableResource {
	readonly close: () => void | Promise<void>;
}

interface ResourceEntry<Resource extends CloseableResource> {
	readonly resource: Promise<Resource>;
	leases: number;
	retired: boolean;
	closing: Promise<void> | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface SharedResourcePool<Key, Resource extends CloseableResource> {
	readonly use: <Result>(
		key: Key,
		run: (resource: Resource) => Promise<Result>,
	) => Promise<Result>;
	readonly remove: (key: Key) => Promise<void>;
	readonly dispose: () => Promise<void>;
}

/**
 * Owns keyed, multiplexable provider resources behind lease-based idle
 * teardown. Concurrent callers share initialization; distinct provider
 * configurations remain isolated; failed starts are evicted for retry.
 */
export const createSharedResourcePool = <
	Key,
	Resource extends CloseableResource,
>(options: {
	readonly create: (key: Key) => Promise<Resource>;
	readonly idleTimeoutMs: number;
}): SharedResourcePool<Key, Resource> => {
	const entries = new Map<Key, ResourceEntry<Resource>>();
	let disposed = false;
	const owned = new Map<ResourceEntry<Resource>, Key>();

	const closeEntry = (
		key: Key,
		entry: ResourceEntry<Resource>,
	): Promise<void> => {
		if (entry.closing) return entry.closing;
		entry.retired = true;
		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		if (entries.get(key) === entry) entries.delete(key);
		entry.closing = (async () => {
			try {
				const resource = await entry.resource;
				await resource.close();
			} catch {
			} finally {
				owned.delete(entry);
			}
		})();
		return entry.closing;
	};

	const scheduleIdleClose = (
		key: Key,
		entry: ResourceEntry<Resource>,
	): void => {
		if (entry.leases === 0 && entry.retired) {
			void closeEntry(key, entry);
			return;
		}
		if (entry.leases !== 0 || entry.idleTimer !== null || disposed) return;
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = null;
			if (entry.leases !== 0 || entries.get(key) !== entry) return;
			void closeEntry(key, entry);
		}, options.idleTimeoutMs);
		entry.idleTimer.unref?.();
	};

	const use = async <Result>(
		key: Key,
		run: (resource: Resource) => Promise<Result>,
	): Promise<Result> => {
		if (disposed) throw new Error("Shared resource pool is disposed");

		let entry = entries.get(key);
		if (entry === undefined) {
			entry = {
				resource: Promise.resolve().then(() => options.create(key)),
				retired: false,
				closing: null,
				leases: 0,
				idleTimer: null,
			};
			entries.set(key, entry);
			owned.set(entry, key);
			void entry.resource.catch(() => {
				if (entries.get(key) === entry) entries.delete(key);
				if (entry) owned.delete(entry);
			});
		}

		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		entry.leases += 1;
		try {
			const resource = await entry.resource;
			if (disposed || entry.retired)
				throw new Error("Shared resource is no longer available");
			return await run(resource);
		} finally {
			entry.leases -= 1;
			scheduleIdleClose(key, entry);
		}
	};

	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		const active = [...owned.entries()];
		entries.clear();
		await Promise.all(active.map(([entry, key]) => closeEntry(key, entry)));
	};

	const remove = async (key: Key): Promise<void> => {
		const entry = entries.get(key);
		if (!entry) return;
		entries.delete(key);
		entry.retired = true;
		if (entry.idleTimer !== null) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		if (entry.leases === 0) await closeEntry(key, entry);
	};
	return { use, remove, dispose };
};
