import {
	PluginConnectError,
	type PluginRequest,
	type PluginResponse,
	type PluginToolRequest,
} from "@zuse/contracts";
import { Context, Data } from "effect";

export interface PluginIdentity {
	readonly tenant: string;
	readonly subject: string;
}

/** Stable `{ error }` codes a plugin operation may surface, shared with clients. */
export const PLUGIN_ERROR_CODES = PluginConnectError.literals;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];
export const isPluginErrorCode = (value: unknown): value is PluginErrorCode =>
	PLUGIN_ERROR_CODES.some((code) => code === value);

export class PluginOperationError extends Data.TaggedError(
	"PluginOperationError",
)<{ readonly code: PluginErrorCode }> {}

export class PluginHost extends Context.Service<
	PluginHost,
	{
		readonly request: (
			identity: PluginIdentity,
			request: PluginRequest,
		) => Promise<PluginResponse>;
		readonly tools: (
			identity: PluginIdentity,
			request: PluginToolRequest,
		) => Promise<unknown>;
		readonly callback: (request: Request) => Promise<Response>;
	}
>()("@zuse/api/PluginHost") {}
