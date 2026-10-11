import { expect, test } from "vitest";
import {
	buildCatalog,
	type FeedEntry,
} from "../../scripts/generate-plugin-catalog.ts";
import {
	findCatalogPlugin,
	PLUGIN_CATALOG,
	publicPluginCatalog,
} from "../../src/plugin-catalog.ts";
import { isAllowedPluginUrl } from "../../src/plugin-egress.ts";

test("generated catalog keeps unique ids, allowed endpoints, and legacy entries", () => {
	expect(PLUGIN_CATALOG.length).toBeGreaterThan(800);
	const ids = PLUGIN_CATALOG.map((plugin) => plugin.id);
	expect(new Set(ids).size).toBe(ids.length);
	for (const plugin of PLUGIN_CATALOG) {
		expect(plugin.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(isAllowedPluginUrl(plugin.endpoint), plugin.endpoint).toBe(true);
		if (plugin.oauthDiscovery)
			expect(isAllowedPluginUrl(plugin.oauthDiscovery)).toBe(true);
		expect(plugin.description.length).toBeLessThanOrEqual(160);
	}
	// Existing connections resolve these ids and hash these exact definitions.
	expect(findCatalogPlugin("linear")).toMatchObject({
		name: "Linear",
		endpoint: "https://mcp.linear.app/mcp",
		auth: "oauth",
		scopes: ["read", "write"],
	});
	expect(findCatalogPlugin("cloudflare")).toMatchObject({
		name: "Cloudflare Docs",
		endpoint: "https://docs.mcp.cloudflare.com/mcp",
		auth: "none",
		scopes: [],
	});
	const featured = PLUGIN_CATALOG.findIndex((plugin) => !plugin.featured);
	expect(featured).toBeGreaterThan(0);
	expect(PLUGIN_CATALOG.slice(featured).some((p) => p.featured)).toBe(false);
});

test("public catalog exposes display metadata only", () => {
	const [first] = publicPluginCatalog();
	expect(Object.keys(first ?? {}).sort()).toEqual(
		[
			"apiKeyHeader",
			"category",
			"custom",
			"description",
			"domain",
			"featured",
			"id",
			"name",
			"url",
		].sort(),
	);
});

const entry = (overrides: Partial<FeedEntry> & { id: string }): FeedEntry => ({
	kind: "mcp",
	name: overrides.id,
	description: "",
	domain: "example.com",
	feeds: ["openai"],
	...overrides,
});

test("generator filters, dedupes by preference, and applies query defaults", () => {
	const catalog = buildCatalog([
		entry({
			id: "discovered/apigee-googleapis-com-mcp",
			feeds: ["discovered"],
			domain: "apigee.googleapis.com",
			connectUrl: "https://apigee.googleapis.com/mcp",
		}),
		entry({
			id: "discovered/betterstack-com-mcp",
			name: "betterstack.com",
			feeds: ["discovered"],
			domain: "betterstack.com",
			description: "Better Stack is an observability platform.",
			connectUrl: "https://mcp.betterstack.com",
			popularity: 1_000,
		}),
		entry({
			id: "mcp/insecure",
			connectUrl: "http://insecure.example.com/mcp",
		}),
		entry({ id: "mcp/stdio", connectUrl: "stdio" }),
		entry({
			id: "cli/tool",
			kind: "cli",
			connectUrl: "https://cli.example.com",
		}),
		entry({
			id: "mcp/acme",
			name: "Acme (OpenAI)",
			connectUrl: "https://mcp.acme.com/mcp",
			popularity: 99,
		}),
		entry({
			id: "curated/acme-com-mcp",
			name: "Acme",
			domain: "acme.com",
			feeds: ["curated"],
			connectUrl: "https://mcp.acme.com/mcp/",
			auth: { kind: "oauth" },
		}),
		entry({
			id: "mcp/posthog",
			connectUrl: "https://mcp.posthog.com/mcp",
			auth: { kind: "api_key" },
		}),
		entry({
			id: "mcp/cloudflare",
			connectUrl: "https://bindings.mcp.cloudflare.com/mcp",
			description: `${"word ".repeat(60)}end`,
		}),
	]);
	expect(catalog.map((plugin) => plugin.id).sort()).toEqual(
		[
			"acme",
			"betterstack",
			"cloudflare",
			"cloudflare-bindings",
			"linear",
			"posthog",
		].sort(),
	);
	// Discovered servers get their product name and rank after the feeds.
	expect(catalog.find((p) => p.id === "betterstack")?.name).toBe(
		"Better Stack",
	);
	expect(catalog.find((p) => p.id === "acme")).toMatchObject({
		name: "Acme",
		auth: "oauth",
	});
	const posthog = catalog.find((p) => p.id === "posthog");
	expect(posthog?.endpoint).toBe("https://mcp.posthog.com/mcp?mode=tools");
	expect(posthog?.oauthDiscovery).toBe("https://mcp.posthog.com/mcp");
	expect(posthog?.auth).toBeUndefined();
	const bindings = catalog.find((p) => p.id === "cloudflare-bindings");
	expect(bindings?.description.length).toBeLessThanOrEqual(160);
	expect(bindings?.description.endsWith("word…")).toBe(true);
	// Legacy entries are always present and featured, even when absent from the feed.
	expect(catalog.find((p) => p.id === "cloudflare")).toMatchObject({
		endpoint: "https://docs.mcp.cloudflare.com/mcp",
		featured: true,
	});
});
