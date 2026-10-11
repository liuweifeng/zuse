import type { PluginAuth } from "./plugin-catalog.ts";
import { PluginOperationError } from "./plugin-host.ts";

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"];
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The single outbound policy for catalog endpoints, OAuth metadata, token
 * calls and authorization URLs: public HTTPS hostnames on the default port.
 * The Worker URL parser canonicalizes numeric hosts, so IPv4 shorthands are
 * caught by the dotted-quad check.
 */
export const isAllowedPluginUrl = (value: string): boolean => {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	const host = url.hostname.toLowerCase();
	return (
		url.protocol === "https:" &&
		!url.username &&
		!url.password &&
		url.port === "" &&
		host.includes(".") &&
		!host.endsWith(".") &&
		!host.startsWith("[") &&
		!IPV4.test(host) &&
		host !== "localhost" &&
		!BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))
	);
};

export const assertPluginUrl = (value: string) => {
	if (!isAllowedPluginUrl(value))
		throw new Error("Plugin endpoint is not allowed");
};

/** Policy-checked fetch that never follows redirects. */
export const pluginFetch: typeof fetch = async (input, init) => {
	assertPluginUrl(
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url,
	);
	const response = await fetch(input, {
		...init,
		redirect: "manual",
		signal: AbortSignal.any([
			...(init?.signal ? [init.signal] : []),
			AbortSignal.timeout(30_000),
		]),
	});
	if (response.status >= 300 && response.status < 400)
		throw new Error("Plugin redirects are not allowed");
	return response;
};

const PROBE_PROTOCOL = "2025-06-18";

/**
 * One MCP `initialize`, with optional credentials. Tools are never listed or
 * called. Returns the response status; failures to answer are unreachable.
 */
async function probeInitialize(
	endpoint: string,
	request: typeof fetch,
	headers: Readonly<Record<string, string>>,
): Promise<number> {
	let response: Response;
	try {
		response = await request(endpoint, {
			method: "POST",
			headers: {
				...headers,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: PROBE_PROTOCOL,
					capabilities: {},
					clientInfo: { name: "zuse-auth-probe", version: "1.0.0" },
				},
			}),
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		throw new PluginOperationError({ code: "plugin_unreachable" });
	}
	await response.body?.cancel().catch(() => undefined);
	if (response.ok) {
		// A server may allocate a session for this check; release it.
		const session = response.headers.get("mcp-session-id");
		if (session)
			await request(endpoint, {
				method: "DELETE",
				headers: {
					...headers,
					"mcp-session-id": session,
					"mcp-protocol-version": PROBE_PROTOCOL,
				},
				signal: AbortSignal.timeout(1_000),
			})
				.then((released) => released.body?.cancel())
				.catch(() => undefined);
	}
	if (response.status === 429 || response.status >= 500)
		throw new PluginOperationError({ code: "plugin_unreachable" });
	return response.status;
}

/** Anonymous probe: success means no sign-in, 401/403 means OAuth. */
export async function probePluginAuth(
	endpoint: string,
	request: typeof fetch = pluginFetch,
): Promise<PluginAuth> {
	const status = await probeInitialize(endpoint, request, {});
	if (status >= 200 && status < 300) return "none";
	if (status === 401 || status === 403) return "oauth";
	throw new PluginOperationError({ code: "plugin_auth_unsupported" });
}

/** Checks an API key before it is saved: 401/403 means the key was rejected. */
export async function probePluginKey(
	endpoint: string,
	header: string,
	value: string,
	request: typeof fetch = pluginFetch,
): Promise<void> {
	const status = await probeInitialize(endpoint, request, { [header]: value });
	if (status >= 200 && status < 300) return;
	throw new PluginOperationError({
		code:
			status === 401 || status === 403
				? "plugin_credentials_rejected"
				: "plugin_auth_unsupported",
	});
}
