import { Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	boundedCache,
	credentialCacheKey,
	credentialScoped,
} from "../../src/credential-cache.ts";

describe("credential scoped cache", () => {
	test("evicts the oldest entry at the bound and keeps re-set keys in place", () => {
		const cache = boundedCache<number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("a", 10);
		expect(cache.size).toBe(2);
		cache.set("c", 3);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
		expect(cache.delete("b")).toBe(true);
		expect(cache.size).toBe(1);
	});

	test("keys isolate credentials and origins while tolerating a trailing slash", () => {
		const key = Redacted.make("key-1");
		expect(credentialCacheKey("https://api.test", key)).toBe(
			credentialCacheKey("https://api.test/", key),
		);
		expect(credentialCacheKey("https://api.test", key)).not.toBe(
			credentialCacheKey("https://api.test", Redacted.make("key-2")),
		);
		expect(credentialCacheKey("https://api.test", key)).not.toBe(
			credentialCacheKey("https://other.test", key),
		);
		expect(credentialCacheKey("https://api.test", key)).not.toContain(
			"Redacted",
		);
	});

	test("creates one value per key and reuses it", () => {
		const cache = boundedCache<{ readonly id: number }>(4);
		let created = 0;
		const make = () => ({ id: ++created });
		const first = credentialScoped(cache, "k", make);
		expect(credentialScoped(cache, "k", make)).toBe(first);
		expect(credentialScoped(cache, "other", make)).not.toBe(first);
		expect(created).toBe(2);
	});
});
