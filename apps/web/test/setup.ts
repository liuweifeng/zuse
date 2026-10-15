import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync } from "node:fs";
import { vi } from "vitest";

Object.defineProperty(globalThis, "AsyncLocalStorage", {
	value: AsyncLocalStorage,
	configurable: true,
	writable: true,
});

vi.mock("@/lib/source", () => ({
	blog: {
		getPages: () =>
			readdirSync(new URL("../content/blog/", import.meta.url))
				.filter((name) => name.endsWith(".mdx"))
				.map((name) => ({ url: `/blog/${name.slice(0, -4)}`, data: {} })),
	},
}));
