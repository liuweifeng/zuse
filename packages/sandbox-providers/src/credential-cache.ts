import { Redacted } from "effect";

/**
 * Isolate-wide, bounded caches keyed by API origin plus credential. The API
 * builds its provider registry per request, so anything worth keeping across
 * requests (SDK sessions, guest control connections) must live here, scoped
 * so one credential can never observe another's entries.
 */
export interface BoundedCache<V> {
	get(key: string): V | undefined;
	set(key: string, value: V): void;
	delete(key: string): boolean;
	readonly size: number;
}

/** Insertion-ordered map that evicts its oldest entry once `limit` is reached. */
export const boundedCache = <V>(limit: number): BoundedCache<V> => {
	const entries = new Map<string, V>();
	return {
		get: (key) => entries.get(key),
		set: (key, value) => {
			if (!entries.has(key) && entries.size >= limit) {
				const oldest = entries.keys().next().value;
				if (oldest !== undefined) entries.delete(oldest);
			}
			entries.set(key, value);
		},
		delete: (key) => entries.delete(key),
		get size() {
			return entries.size;
		},
	};
};

/** Origin is normalized so a trailing slash cannot split one credential into two entries. */
export const credentialCacheKey = (
	origin: string,
	apiKey: Redacted.Redacted<string>,
): string => `${origin.replace(/\/+$/u, "")}\u0000${Redacted.value(apiKey)}`;

export const credentialScoped = <V>(
	cache: BoundedCache<V>,
	key: string,
	create: () => V,
): V => {
	const existing = cache.get(key);
	if (existing !== undefined) return existing;
	const created = create();
	cache.set(key, created);
	return created;
};
