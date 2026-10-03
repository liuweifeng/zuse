import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Result, Schema } from "effect";
import { atomicWritePrivateJson } from "../atomic-private-file.ts";

/** Serialisable launch configuration. Stored privately, never placed on the command line. */
export const DesktopEngineConfig = Schema.Struct({
	userData: Schema.String,
	appVersion: Schema.String,
	apiPort: Schema.Number,
	bindHost: Schema.String,
	advertisedHost: Schema.NullOr(Schema.String),
	apiUrl: Schema.String,
	staticDir: Schema.optional(Schema.String),
	devServerUrl: Schema.optional(Schema.String),
	cliAccessPath: Schema.optional(Schema.String),
	nearbyTls: Schema.optional(
		Schema.Struct({
			key: Schema.String,
			cert: Schema.String,
			pin: Schema.String,
		}),
	),
});
export type DesktopEngineConfig = typeof DesktopEngineConfig.Type;

export const readDesktopEngineConfig = async (
	path: string,
): Promise<DesktopEngineConfig> => {
	try {
		const decoded = Schema.decodeUnknownResult(DesktopEngineConfig)(
			JSON.parse(await readFile(path, "utf8")),
		);
		if (
			Result.isFailure(decoded) ||
			!isAbsolute(decoded.success.userData) ||
			!Number.isInteger(decoded.success.apiPort) ||
			decoded.success.apiPort < 1 ||
			decoded.success.apiPort > 65535
		)
			throw new Error("Invalid configuration");
		return decoded.success;
	} catch {
		throw new Error(
			"The private engine launch configuration could not be read or is invalid.",
		);
	}
};

export const writeDesktopEngineConfig = async (
	config: DesktopEngineConfig,
): Promise<string> => {
	const path = join(config.userData, "engine", "launch.json");
	await atomicWritePrivateJson(path, config);
	return path;
};
