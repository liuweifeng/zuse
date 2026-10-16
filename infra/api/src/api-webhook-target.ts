import { isPrivateOrLocalHost } from "@zuse/contracts";

export const API_WEBHOOK_URL_MAX_LENGTH = 2_048;

const normalizedHostname = (value: string): string | null => {
	try {
		const url = new URL(value);
		return url.hostname.toLowerCase().replace(/\.+$/u, "");
	} catch {
		return null;
	}
};

export const safeApiWebhookTarget = (
	value: string,
	forbiddenOrigin: string,
): URL | null => {
	if (value.length === 0 || value.length > API_WEBHOOK_URL_MAX_LENGTH)
		return null;
	let target: URL;
	try {
		target = new URL(value);
	} catch {
		return null;
	}
	const hostname = target.hostname.toLowerCase().replace(/\.+$/u, "");
	target.hostname = hostname;
	if (
		target.protocol !== "https:" ||
		target.username.length > 0 ||
		target.password.length > 0 ||
		target.hash.length > 0 ||
		hostname.length === 0 ||
		isPrivateOrLocalHost(hostname) ||
		/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname) ||
		hostname.includes(":") ||
		hostname === normalizedHostname(forbiddenOrigin)
	)
		return null;
	return target;
};
