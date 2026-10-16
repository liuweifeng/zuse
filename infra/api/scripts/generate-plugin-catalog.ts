import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const FEED_URL = "https://integrations.sh/api.json";

export interface FeedEntry {
	readonly id: string;
	readonly kind: string;
	readonly name: string;
	readonly description?: string;
	readonly domain?: string;
	readonly categories?: readonly string[];
	readonly feeds?: readonly string[];
	readonly connectUrl?: string;
	readonly oauthDiscoveryUrl?: string;
	readonly auth?: { readonly kind?: string } | null;
	readonly popularity?: number;
}

export interface GeneratedPlugin {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly domain: string;
	readonly category: string | null;
	readonly featured: boolean;
	readonly endpoint: string;
	readonly oauthDiscovery?: string;
	readonly auth?: "oauth" | "none";
	readonly scopes?: readonly string[];
	readonly popularity: number;
}

const LEGACY: readonly Omit<GeneratedPlugin, "featured" | "popularity">[] = [
	{
		id: "linear",
		name: "Linear",
		endpoint: "https://mcp.linear.app/mcp",
		auth: "oauth",
		scopes: ["read", "write"],
		description: "Find and update issues, projects, and documents.",
		domain: "linear.app",
		category: "productivity",
	},
	{
		id: "cloudflare",
		name: "Cloudflare Docs",
		endpoint: "https://docs.mcp.cloudflare.com/mcp",
		auth: "none",
		scopes: [],
		description: "Search Cloudflare documentation from your agents.",
		domain: "cloudflare.com",
		category: "developer-tools",
	},
];

const FEATURED = [
	"linear",
	"notion",
	"sentry",
	"atlassian",
	"asana",
	"canva",
	"figma",
	"hubspot",
	"supabase",
	"vercel",
	"cloudflare",
	"context7",
	"granola",
	"miro",
	"zapier",
	"intercom",
];

const QUERY_DEFAULTS = [
	{ host: "mcp.posthog.com", name: "mode", value: "tools" },
	{ host: "mcp.cloudflare.com", name: "codemode", value: "false" },
];

const FEED_RANK: Record<string, number> = {
	curated: 0,
	claude: 1,
	openai: 2,
	discovered: 4,
};
const rank = (entry: FeedEntry) =>
	Math.min(4, ...(entry.feeds ?? []).map((feed) => FEED_RANK[feed] ?? 3));
const discoveredOnly = (entry: FeedEntry) =>
	(entry.feeds ?? []).every((feed) => feed === "discovered");

const PREFIX_LABELS = new Set(["api", "mcp", "app", "www", "docs"]);
export const productName = (entry: FeedEntry): string => {
	const parts = (entry.domain ?? "").toLowerCase().split(".");
	while (parts.length > 2 && PREFIX_LABELS.has(parts[0] ?? "")) parts.shift();
	const label = parts[0] ?? "";
	const compact = (value: string) =>
		value.toLowerCase().replace(/[^a-z0-9]/g, "");
	const words = (entry.description ?? "").match(/[A-Za-z0-9][\w.&'+-]*/g) ?? [];
	for (let count = 1; count <= 4; count++) {
		const candidate = words.slice(0, count);
		if (
			candidate.length === count &&
			compact(candidate.join("")) === compact(label)
		)
			return candidate.join(" ").replace(/[.,]+$/, "");
	}
	return label
		.split("-")
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
};

const needsRegisteredClient = (entry: FeedEntry) =>
	(entry.domain ?? "").endsWith("googleapis.com");

const dedupeKey = (href: string) => href.replace(/\/+$/, "").toLowerCase();

const trimDescription = (value: string, limit = 160) => {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= limit) return text;
	const cut = text.slice(0, limit - 1);
	const boundary = cut.lastIndexOf(" ");
	return `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
};

const slug = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

const baseId = (entry: FeedEntry) => {
	let id = slug(entry.id.replace(/^[^/]+\//, "")).replace(/-mcp$/, "");
	const domain = entry.domain?.toLowerCase() ?? "";
	if (domain && id === slug(domain)) id = slug(domain.split(".")[0] ?? id);
	return id || "plugin";
};

const withQueryDefaults = (href: string) => {
	const url = new URL(href);
	let changed = false;
	for (const rule of QUERY_DEFAULTS) {
		if (url.hostname !== rule.host || url.searchParams.has(rule.name)) continue;
		url.searchParams.set(rule.name, rule.value);
		changed = true;
	}
	return changed ? url.href : href;
};

const usableUrl = (href: string | undefined): string | undefined => {
	if (!href || /[{}\s]/.test(href) || !URL.canParse(href)) return undefined;
	const url = new URL(href);
	if (url.protocol !== "https:" || url.username || url.password || url.hash)
		return undefined;
	return url.href;
};

const uniqueId = (entry: FeedEntry, endpoint: string, used: Set<string>) => {
	const base = baseId(entry);
	let id = base;
	if (used.has(id)) {
		const host = slug(new URL(endpoint).hostname.split(".")[0] ?? "");
		if (host && host !== base && host !== "mcp") id = `${base}-${host}`;
		for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
	}
	used.add(id);
	return id;
};

type Draft = Omit<GeneratedPlugin, "featured">;

const ordered = (plugin: Draft, featured: boolean): GeneratedPlugin => ({
	id: plugin.id,
	name: plugin.name,
	description: plugin.description,
	domain: plugin.domain,
	category: plugin.category,
	featured,
	endpoint: plugin.endpoint,
	...(plugin.oauthDiscovery ? { oauthDiscovery: plugin.oauthDiscovery } : {}),
	...(plugin.auth ? { auth: plugin.auth } : {}),
	...(plugin.scopes ? { scopes: plugin.scopes } : {}),
	popularity: plugin.popularity,
});

export function buildCatalog(
	feed: readonly FeedEntry[],
): readonly GeneratedPlugin[] {
	const candidates = feed
		.filter((entry) => entry.kind === "mcp")
		.filter((entry) => !(discoveredOnly(entry) && needsRegisteredClient(entry)))
		.flatMap((entry) => {
			const original = usableUrl(entry.connectUrl);
			return original ? [{ entry, original }] : [];
		})
		.sort(
			(a, b) =>
				rank(a.entry) - rank(b.entry) ||
				(b.entry.popularity ?? 0) - (a.entry.popularity ?? 0) ||
				a.entry.id.localeCompare(b.entry.id),
		);
	const seen = new Set<string>();
	const used = new Set(LEGACY.map((legacy) => legacy.id));
	const legacyByUrl = new Map(
		LEGACY.map((legacy) => [dedupeKey(legacy.endpoint), legacy]),
	);
	const result: Draft[] = [];
	const matchedLegacy = new Set<string>();
	for (const { entry, original } of candidates) {
		const key = dedupeKey(original);
		if (seen.has(key)) continue;
		seen.add(key);
		const endpoint = withQueryDefaults(original);
		const discovery = usableUrl(entry.oauthDiscoveryUrl) ?? original;
		const hint = entry.auth?.kind;
		const common = {
			description: trimDescription(entry.description ?? ""),
			domain: entry.domain ?? new URL(original).hostname,
			category: entry.categories?.[0] || null,
			popularity: entry.popularity ?? 0,
		};
		const legacy = legacyByUrl.get(key);
		if (legacy) matchedLegacy.add(legacy.id);
		result.push(
			legacy
				? { ...legacy, popularity: common.popularity }
				: {
						id: uniqueId(entry, original, used),
						name: discoveredOnly(entry)
							? productName(entry) || entry.name.trim()
							: entry.name.trim(),
						...common,
						endpoint,
						...(discovery !== endpoint ? { oauthDiscovery: discovery } : {}),
						...(hint === "oauth" || hint === "none" ? { auth: hint } : {}),
					},
		);
	}
	for (const legacy of LEGACY)
		if (!matchedLegacy.has(legacy.id))
			result.push({ ...legacy, popularity: 0 });
	const featured = new Map(FEATURED.map((id, index) => [id, index]));
	return result
		.map((plugin) => ordered(plugin, featured.has(plugin.id)))
		.sort(
			(a, b) =>
				(featured.get(a.id) ?? Infinity) - (featured.get(b.id) ?? Infinity) ||
				b.popularity - a.popularity ||
				a.name.localeCompare(b.name) ||
				a.id.localeCompare(b.id),
		);
}

const render = (plugins: readonly GeneratedPlugin[]) =>
	`// Generated by infra/api/scripts/generate-plugin-catalog.ts from ${FEED_URL}. Do not edit.
import type { CatalogPlugin } from "./plugin-catalog.ts";

export const PLUGIN_CATALOG_DATA: readonly CatalogPlugin[] = ${JSON.stringify(plugins, null, "\t")};
`;

if (import.meta.main) {
	const inputIndex = process.argv.indexOf("--input");
	const input = inputIndex === -1 ? undefined : process.argv[inputIndex + 1];
	const raw = input
		? await readFile(input, "utf8")
		: await fetch(FEED_URL, { redirect: "error" }).then((response) => {
				if (!response.ok) throw new Error(`Feed returned ${response.status}`);
				return response.text();
			});
	const feed = JSON.parse(raw) as { data: readonly FeedEntry[] };
	const plugins = buildCatalog(feed.data);
	const output = fileURLToPath(
		new URL("../src/plugin-catalog.data.ts", import.meta.url),
	);
	await writeFile(output, render(plugins));
	execFileSync("bunx", ["biome", "format", "--write", output], {
		stdio: "inherit",
	});
	console.log(`Wrote ${plugins.length} plugins to ${output}`);
}
