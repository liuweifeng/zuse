import type { EnvironmentRecord } from "./store.ts";
export const publicEndpoint = (environment: EnvironmentRecord) =>
	environment.tunnelHostname !== undefined
		? {
				httpBaseUrl: `https://${environment.tunnelHostname}`,
				wsBaseUrl: `wss://${environment.tunnelHostname}`,
			}
		: {
				httpBaseUrl: environment.httpBaseUrl,
				wsBaseUrl: environment.wsBaseUrl,
			};

export const hasManagedPublicEndpoint = (
	environment: EnvironmentRecord,
): boolean => {
	if (environment.tunnelHostname !== undefined) return true;
	try {
		const endpoint = new URL(environment.httpBaseUrl);
		const hostname = endpoint.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
		return (
			endpoint.protocol === "https:" &&
			hostname !== "localhost" &&
			hostname !== "127.0.0.1" &&
			hostname !== "::1"
		);
	} catch {
		return false;
	}
};
