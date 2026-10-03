import type { DesktopEngineEndpoint } from "@zusehq/server/desktop-engine";

/** Desktop launch admission remains closed until its owning maintenance action releases it. */
export const makeEngineMaintenance = (options: {
	readonly startup: () => Promise<unknown> | null;
	readonly endpoint: () => Promise<DesktopEngineEndpoint | null>;
	readonly shutdown: (
		endpoint: DesktopEngineEndpoint,
	) => Promise<"stopped" | "busy">;
}) => {
	let owner: symbol | null = null;
	return {
		blocked: () => owner !== null,
		scope: () => {
			const identity = Symbol();
			const resume = () => {
				if (owner === identity) owner = null;
			};
			return {
				resume,
				prepare: async (): Promise<"stopped" | "busy"> => {
					if (owner !== null) return "busy";
					owner = identity;
					try {
						await options.startup();
						const endpoint = await options.endpoint();
						if (endpoint === null)
							throw new Error(
								"The engine is reconnecting. Retry when it is available.",
							);
						const status = await options.shutdown(endpoint);
						if (status === "busy") resume();
						return status;
					} catch (error) {
						resume();
						throw error;
					}
				},
			};
		},
	};
};
