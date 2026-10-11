import { isHostedProduct } from "./platform-capabilities.ts";

export { isHostedProduct } from "./platform-capabilities.ts";

import { AuthSession, type AuthState, AuthUser } from "@zuse/contracts";
import { Schema } from "effect";
import { observeRendererAccount } from "./renderer-account.ts";
export const SESSION_KEY = "zuse.hosted.session.v1";

export type HostedSession = {
	readonly user?: AuthUser;
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly expiresAt: number;
};

const authListeners = new Set<() => void>();
let authRaw: string | null | undefined;
let authState: AuthState = { _tag: "SignedOut" };

export const hostedAuthState = (): AuthState => {
	const raw =
		localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY);
	if (raw === authRaw) return authState;
	let next: AuthState = { _tag: "SignedOut" };
	try {
		const session = readSession();
		if (session?.user !== undefined) {
			const user = Schema.decodeUnknownSync(AuthUser)(session.user);
			if (user.id === hostedAccountId())
				next = {
					_tag: "SignedIn",
					session: AuthSession.make({
						user,
						expiresAt: session.expiresAt,
						organizationId: null,
					}),
				};
		}
	} catch {
		/* Invalid cached profiles are never replaced with host account data. */
	}
	authRaw = raw;
	authState = next;
	return authState;
};

export const subscribeHostedAuth = (listener: () => void): (() => void) => {
	authListeners.add(listener);
	return () => {
		authListeners.delete(listener);
	};
};

export const publishHostedAuth = (): void => {
	const state = hostedAuthState();
	const subject = state._tag === "SignedIn" ? state.session.user.id : null;

	observeRendererAccount(subject);
	for (const listener of authListeners) listener();
};

export const decodeHostedJwtPayload = (
	token: string,
): { readonly exp?: unknown; readonly sub?: unknown } | null => {
	try {
		const encoded = token.split(".")[1];
		if (encoded === undefined) return null;
		const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
		return JSON.parse(atob(normalized)) as {
			readonly exp?: unknown;
			readonly sub?: unknown;
		};
	} catch {
		return null;
	}
};

export const jwtExpiry = (token: string): number => {
	const payload = decodeHostedJwtPayload(token);
	return typeof payload?.exp === "number"
		? payload.exp * 1_000
		: Date.now() + 5 * 60_000;
};

export const readSession = (): HostedSession | null => {
	try {
		let raw = localStorage.getItem(SESSION_KEY);
		if (raw === null) {
			raw = sessionStorage.getItem(SESSION_KEY);
			if (raw !== null) {
				localStorage.setItem(SESSION_KEY, raw);
				sessionStorage.removeItem(SESSION_KEY);
			}
		}
		if (raw === null) return null;
		const value = JSON.parse(raw) as Partial<HostedSession>;
		return value !== null &&
			typeof value.accessToken === "string" &&
			typeof value.refreshToken === "string" &&
			typeof value.expiresAt === "number"
			? (value as HostedSession)
			: null;
	} catch {
		return null;
	}
};

export const hostedAccountId = (): string | null => {
	const token = readSession()?.accessToken;
	if (token === undefined) return null;
	const payload = decodeHostedJwtPayload(token);
	return typeof payload?.sub === "string" ? payload.sub : null;
};

export const writeSession = (session: HostedSession): HostedSession => {
	localStorage.setItem(SESSION_KEY, JSON.stringify(session));
	sessionStorage.removeItem(SESSION_KEY);
	publishHostedAuth();
	return session;
};

export const hostedAccountUser = (): AuthUser | null =>
	readSession()?.user ?? null;
export const hostedCacheDatabaseName = (base: string): string =>
	isHostedProduct() ? `${base}:hosted:${hostedAccountId()}` : base;
