import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { atomicWritePrivateJson } from "../atomic-private-file.ts";
import { LOCAL_ENGINE_PROTOCOL } from "./channel.ts";

const Endpoint = Schema.Struct({
	version: Schema.Number,
	port: Schema.Number,
	token: Schema.String,
	pid: Schema.Number,
	supervisorPid: Schema.optional(Schema.Number),
	appVersion: Schema.String,
	buildId: Schema.optional(Schema.String),
	apiPort: Schema.Number,
	network: Schema.optional(
		Schema.Struct({
			bindHost: Schema.String,
			advertisedHost: Schema.NullOr(Schema.String),
		}),
	),
});
export type DesktopEngineEndpoint = typeof Endpoint.Type;
export const engineEndpointPath = (userData: string): string =>
	join(userData, "engine", "endpoint.json");
const decode = Schema.decodeUnknownResult(Endpoint);

export const readEngineEndpoint = async (
	userData: string,
): Promise<DesktopEngineEndpoint | null> => {
	let content: string;
	try {
		content = await readFile(engineEndpointPath(userData), "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return null;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("The local engine endpoint is invalid.");
	}
	const decoded = decode(value);
	if (
		Result.isFailure(decoded) ||
		!Number.isInteger(decoded.success.port) ||
		decoded.success.port < 1 ||
		decoded.success.port > 65535 ||
		decoded.success.token.length !== 64
	)
		throw new Error("The local engine endpoint is invalid.");
	return decoded.success;
};
export const publishEngineEndpoint = (
	userData: string,
	endpoint: Omit<DesktopEngineEndpoint, "version">,
) =>
	atomicWritePrivateJson(engineEndpointPath(userData), {
		...endpoint,
		version: LOCAL_ENGINE_PROTOCOL,
	});
export const removeEngineEndpoint = async (
	userData: string,
	token: string,
): Promise<void> => {
	const current = await readEngineEndpoint(userData);
	if (current?.token === token)
		await rm(engineEndpointPath(userData), { force: true });
};
