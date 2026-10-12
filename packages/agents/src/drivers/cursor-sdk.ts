import type * as CursorSdk from "@cursor/sdk";

export type CursorSdkModule = typeof CursorSdk;

let pending: Promise<CursorSdkModule> | null = null;
let loaded: CursorSdkModule | null = null;

/**
 * The Cursor SDK is a multi-megabyte external module whose evaluation builds
 * large schemas. Load it on the first real Cursor API call, never at server
 * startup, so workspaces running other agents never pay for it. One shared
 * in-flight import serves every caller.
 */
export const loadCursorSdk = (): Promise<CursorSdkModule> => {
	pending ??= import("@cursor/sdk").then((module) => {
		loaded = module;
		return module;
	});
	return pending;
};

/** Whether the SDK has been loaded in this process; nothing is loaded by asking. */
export const cursorSdkLoaded = (): boolean => loaded !== null;

/**
 * Error classification never loads the SDK: an error can only be an SDK
 * instance if the SDK was already loaded to produce it. Callers keep their
 * message-based fallbacks for errors raised elsewhere.
 */
export const cursorSdkErrorOf = (
	cause: unknown,
): CursorSdk.CursorSdkError | null =>
	loaded !== null && cause instanceof loaded.CursorSdkError ? cause : null;

export const isCursorAuthenticationError = (cause: unknown): boolean =>
	loaded !== null &&
	(cause instanceof loaded.AuthenticationError ||
		(cause instanceof loaded.CursorSdkError && cause.status === 401));

export const isCursorAgentNotFoundError = (cause: unknown): boolean =>
	loaded !== null && cause instanceof loaded.AgentNotFoundError;
