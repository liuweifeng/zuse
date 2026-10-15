import {
	DAYTONA_PROVIDER_ID,
	makeDaytonaSandboxProvider,
} from "@zuse/sandbox-providers/daytona";
import { Redacted, Schema } from "effect";
import type { SandboxProviderModule } from "../sandbox-provider-module.ts";
import {
	ConfiguredString,
	decodeProviderEnvironment,
	HttpsUrl,
} from "./environment.ts";

const Activation = Schema.Struct({
	DAYTONA_ADAPTER_ENABLED: Schema.optionalKey(
		Schema.Literals(["true", "false"]),
	),
});
const PositiveInteger = Schema.NumberFromString.check(
	Schema.isInt(),
	Schema.isGreaterThan(0),
);
const Environment = Schema.Struct({
	DAYTONA_API_KEY: Schema.optionalKey(ConfiguredString),
	DAYTONA_API_BASE_URL: Schema.optionalKey(HttpsUrl),
	DAYTONA_TEMPLATE_ID: ConfiguredString,
	DAYTONA_TEMPLATE_VERSION: ConfiguredString,
	DAYTONA_TARGET: Schema.optionalKey(ConfiguredString),
	DAYTONA_VCPU_COUNT: PositiveInteger,
	DAYTONA_MEMORY_MIB: PositiveInteger,
});

export const DaytonaSandboxProviderModule: SandboxProviderModule = {
	providerId: DAYTONA_PROVIDER_ID,
	// Promote only after live runtime, image-build and usage-delivery verification.
	productionReady: false,
	configure: ({ env }) => {
		if (
			decodeProviderEnvironment(Activation, env, "Daytona")
				.DAYTONA_ADAPTER_ENABLED !== "true"
		)
			return undefined;
		const config = decodeProviderEnvironment(Environment, env, "Daytona");
		return {
			advertised: true,
			managedPlacementEnabled: config.DAYTONA_API_KEY !== undefined,
			adapter: makeDaytonaSandboxProvider({
				apiKey: Redacted.make(config.DAYTONA_API_KEY ?? ""),
				templateId: config.DAYTONA_TEMPLATE_ID,
				templateVersion: config.DAYTONA_TEMPLATE_VERSION,
				target: config.DAYTONA_TARGET,
				apiBaseUrl: config.DAYTONA_API_BASE_URL?.href,
				resources: {
					vcpuCount: config.DAYTONA_VCPU_COUNT,
					memoryMib: config.DAYTONA_MEMORY_MIB,
				},
			}),
		};
	},
};
