import { describe, expect, it } from "vitest";
import {
	apiKeyValue,
	type CustomServerDraft,
	customServerAuthOf,
	pluginConnectErrorKey,
	pluginDomain,
	validateCustomServer,
} from "../../src/lib/plugin-servers.ts";

const draft = (patch: Partial<CustomServerDraft>): CustomServerDraft => ({
	name: "Internal",
	url: "https://mcp.example.com/mcp",
	auth: "auto",
	token: "",
	headerName: "",
	headerValue: "",
	...patch,
});

describe("custom MCP servers", () => {
	it("detects sign-in when no key is given", () => {
		expect(validateCustomServer(draft({ name: "  Internal  " }))).toEqual({
			ok: true,
			input: { name: "Internal", url: "https://mcp.example.com/mcp" },
		});
	});

	it("sends bearer tokens in Authorization without doubling the scheme", () => {
		const input = (token: string) => {
			const result = validateCustomServer(draft({ auth: "bearer", token }));
			return result.ok ? result.input.apiKey : null;
		};
		expect(input(" sk-1 ")).toEqual({
			header: "Authorization",
			value: "Bearer sk-1",
		});
		expect(input("bearer sk-1")).toEqual({
			header: "Authorization",
			value: "bearer sk-1",
		});
		expect(apiKeyValue("authorization", "sk-2")).toBe("Bearer sk-2");
		expect(apiKeyValue("X-API-Key", "sk-2")).toBe("sk-2");
	});

	it("sends custom headers as entered", () => {
		expect(
			validateCustomServer(
				draft({ auth: "header", headerName: "X-API-Key", headerValue: "k" }),
			),
		).toEqual({
			ok: true,
			input: {
				name: "Internal",
				url: "https://mcp.example.com/mcp",
				apiKey: { header: "X-API-Key", value: "k" },
			},
		});
	});

	it("points at the field to fix", () => {
		const field = (patch: Partial<CustomServerDraft>) => {
			const result = validateCustomServer(draft(patch));
			return result.ok ? null : result.field;
		};
		expect(field({ name: " " })).toBe("name");
		expect(field({ name: "x".repeat(61) })).toBe("name");
		expect(field({ url: "http://mcp.example.com" })).toBe("url");
		expect(field({ url: "mcp.example.com" })).toBe("url");
		expect(field({ auth: "bearer" })).toBe("token");
		expect(field({ auth: "header", headerName: "X Key" })).toBe("header");
		expect(field({ auth: "header", headerName: "X-Key" })).toBe("value");
	});

	it("shows custom servers with their host's logo", () => {
		const plugin = (url: string | null, domain = "") => ({ domain, url });
		expect(pluginDomain(plugin("https://mcp.linear.app/mcp"))).toBe(
			"linear.app",
		);
		expect(pluginDomain(plugin("https://tools.acme.dev/sse"))).toBe(
			"tools.acme.dev",
		);
		expect(pluginDomain(plugin(null, "notion.com"))).toBe("notion.com");
		expect(pluginDomain(plugin("not a url"))).toBe("");
	});

	it("describes how a saved server authenticates", () => {
		expect(customServerAuthOf({ apiKeyHeader: null })).toBe("auto");
		expect(customServerAuthOf({ apiKeyHeader: "Authorization" })).toBe(
			"bearer",
		);
		expect(customServerAuthOf({ apiKeyHeader: "X-API-Key" })).toBe("header");
	});

	it("only suggests an API key where one can be entered", () => {
		expect(pluginConnectErrorKey("plugin_auth_unsupported", true)).toBe(
			"plugins:plugins_error_auth_unsupported",
		);
		expect(pluginConnectErrorKey("plugin_auth_unsupported", false)).toBe(
			"plugins:plugins_error_setup_unsupported",
		);
		expect(pluginConnectErrorKey(null, false)).toBe(
			"plugins:plugins_connect_failed_detail",
		);
	});
});
