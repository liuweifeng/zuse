import type {
	PluginConnectError,
	PluginDefinition,
	PluginSnapshot,
	PluginTenant,
} from "@zuse/contracts";
import type { MessageKey } from "@zuse/i18n";

/** How a custom MCP server authenticates. `auto` lets the server pick OAuth or public. */
export type CustomServerAuth = "auto" | "bearer" | "header";

export const CUSTOM_SERVER_NAME_LIMIT = 60;
const BEARER_HEADER = "Authorization";
// RFC 9110 field-name token characters.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BEARER_PREFIX = /^bearer\s+/i;
// Display-only: strip well-known service prefixes so the logo lookup finds the brand.
const SERVICE_PREFIX = /^(?:www|mcp|api|server)\./i;

/** Host of an http(s) URL, or null when it doesn't parse. */
const hostOf = (url: string | null): string | null => {
	if (url === null) return null;
	try {
		return new URL(url).hostname || null;
	} catch {
		return null;
	}
};

/**
 * The domain used for a plugin's logo. Catalog entries carry one; custom
 * servers fall back to their URL's host (the icon falls back to an initial).
 */
export const pluginDomain = (
	plugin: Pick<PluginDefinition, "domain" | "url">,
): string => {
	if (plugin.domain) return plugin.domain;
	const host = hostOf(plugin.url);
	if (host === null) return "";
	const stripped = host.replace(SERVICE_PREFIX, "");
	return stripped.includes(".") ? stripped : host;
};

/** Key values for the Authorization header always carry the Bearer scheme. */
export const apiKeyValue = (header: string, raw: string): string => {
	const value = raw.trim();
	return header.toLowerCase() === BEARER_HEADER.toLowerCase() &&
		!BEARER_PREFIX.test(value)
		? `Bearer ${value}`
		: value;
};

/** Which authentication a saved custom server uses, for display. */
export const customServerAuthOf = (
	plugin: Pick<PluginDefinition, "apiKeyHeader">,
): CustomServerAuth =>
	plugin.apiKeyHeader === null
		? "auto"
		: plugin.apiKeyHeader.toLowerCase() === BEARER_HEADER.toLowerCase()
			? "bearer"
			: "header";

export type CustomServerDraft = {
	readonly name: string;
	readonly url: string;
	readonly auth: CustomServerAuth;
	readonly token: string;
	readonly headerName: string;
	readonly headerValue: string;
};

export type CustomServerField = "name" | "url" | "token" | "header" | "value";

export type CustomServerInput = {
	readonly name: string;
	readonly url: string;
	readonly apiKey?: { readonly header: string; readonly value: string };
};

/**
 * Light client-side checks before asking the server, which stays authoritative
 * (it also rejects private hosts and non-default ports).
 */
export const validateCustomServer = (
	draft: CustomServerDraft,
):
	| { readonly ok: true; readonly input: CustomServerInput }
	| {
			readonly ok: false;
			readonly field: CustomServerField;
			readonly error: MessageKey;
	  } => {
	const name = draft.name.trim();
	if (name.length === 0)
		return {
			ok: false,
			field: "name",
			error: "plugins:plugins_add_server_name_required",
		};
	if (name.length > CUSTOM_SERVER_NAME_LIMIT)
		return {
			ok: false,
			field: "name",
			error: "plugins:plugins_add_server_name_too_long",
		};
	const url = draft.url.trim();
	let parsed: URL | null = null;
	try {
		parsed = new URL(url);
	} catch {
		parsed = null;
	}
	if (parsed === null || parsed.protocol !== "https:" || !parsed.hostname)
		return {
			ok: false,
			field: "url",
			error: "plugins:plugins_add_server_url_invalid",
		};
	if (draft.auth === "auto") return { ok: true, input: { name, url } };
	if (draft.auth === "bearer") {
		if (draft.token.trim().length === 0)
			return {
				ok: false,
				field: "token",
				error: "plugins:plugins_add_server_value_required",
			};
		return {
			ok: true,
			input: {
				name,
				url,
				apiKey: {
					header: BEARER_HEADER,
					value: apiKeyValue(BEARER_HEADER, draft.token),
				},
			},
		};
	}
	const header = draft.headerName.trim();
	if (!HEADER_NAME.test(header))
		return {
			ok: false,
			field: "header",
			error: "plugins:plugins_add_server_header_invalid",
		};
	if (draft.headerValue.trim().length === 0)
		return {
			ok: false,
			field: "value",
			error: "plugins:plugins_add_server_value_required",
		};
	return {
		ok: true,
		input: {
			name,
			url,
			apiKey: { header, value: apiKeyValue(header, draft.headerValue) },
		},
	};
};

/**
 * One explanation per connect failure, shared by catalog connects and custom
 * servers. Suggesting an API key only makes sense where the user can enter one.
 */
export const pluginConnectErrorKey = (
	error: PluginConnectError | null,
	custom: boolean,
): MessageKey => {
	switch (error) {
		case "plugin_auth_unsupported":
			return custom
				? "plugins:plugins_error_auth_unsupported"
				: "plugins:plugins_error_setup_unsupported";
		case "plugin_client_registration_unsupported":
			return custom
				? "plugins:plugins_error_client_registration_unsupported"
				: "plugins:plugins_error_setup_unsupported";
		case "plugin_unreachable":
			return "plugins:plugins_error_unreachable";
		case "plugin_url_rejected":
			return "plugins:plugins_error_url_rejected";
		case "plugin_credentials_rejected":
			return "plugins:plugins_error_credentials_rejected";
		case "plugin_limit_reached":
			return "plugins:plugins_error_limit_reached";
		case "plugin_operation_failed":
		case null:
			return "plugins:plugins_connect_failed_detail";
	}
};

/** The workspace a snapshot belongs to, so personal vs organization is explicit. */
export const pluginTenantOf = (
	snapshot: Pick<PluginSnapshot, "tenants" | "tenantId">,
): PluginTenant | null =>
	snapshot.tenants.find((tenant) => tenant.id === snapshot.tenantId) ?? null;
