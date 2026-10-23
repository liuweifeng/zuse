import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import { makePkce } from "../auth/pkce.ts";
import {
	ConnectionRegistry,
	ModelAuthError,
	postOAuthForm,
} from "./connection-registry.ts";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const planUsageScope = "chatgpt.tokens.use.direct";
const scopes = `openid profile email offline_access resource.invoke ${planUsageScope}`;
const tokenSchema = z.object({
	access_token: z.string().min(1).optional(),
	token_type: z.string().optional(),
	refresh_token: z.string().min(1).optional(),
	id_token: z.string().optional(),
	expires_in: z.number().positive().optional(),
	scope: z.string().optional(),
	earliest_refresh_at: z.union([z.number(), z.string()]).optional(),
});

import type {
	ConnectionMetadata,
	ModelRegistration,
	ModelVault,
} from "./connection-types.ts";

const same = (a: string, b: string): boolean => {
	const x = Buffer.from(a),
		y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};
const metadata = (registration: ModelRegistration): ConnectionMetadata => {
	const authorized =
		!!registration.accessToken &&
		!!registration.refreshToken &&
		registration.scope.split(/\s+/).includes(planUsageScope);
	return {
		id: registration.id,
		clientId: registration.clientId,
		name: registration.name,
		email: registration.email,
		createdAt: registration.createdAt,
		preferred: registration.preferred,
		authorized,
		planNoticeSeen: registration.planNoticeSeen ?? false,
		status: authorized
			? "connected"
			: registration.idToken
				? "permission-required"
				: "disconnected",
	};
};
const refreshTimestamp = (
	value: number | string | undefined,
): number | undefined => {
	if (value === undefined) return undefined;
	const numeric = typeof value === "number" ? value : Number(value);
	const timestamp = Number.isFinite(numeric)
		? numeric < 1e12
			? numeric * 1000
			: numeric
		: Date.parse(String(value));
	if (!Number.isFinite(timestamp))
		throw new ModelAuthError("verification_failed");
	return timestamp;
};
/** Tokens never leave this server-owned service except to its model transport. */
export class ChatGPTOAuth extends ConnectionRegistry {
	private keys: ReturnType<typeof createRemoteJWKSet> | undefined;
	private async signingKeys() {
		if (this.keys) return this.keys;
		const response = await this.fetcher(
			`${issuer}/.well-known/openid-configuration`,
			{ signal: AbortSignal.timeout(5000), redirect: "error" },
		);
		if (!response.ok) throw new ModelAuthError("discovery_failed");
		const discovery = z
			.object({ issuer: z.literal(issuer), jwks_uri: z.string().url() })
			.parse(await response.json());
		if (new URL(discovery.jwks_uri).origin !== issuer)
			throw new ModelAuthError("invalid_discovery");
		this.keys = createRemoteJWKSet(new URL(discovery.jwks_uri), {
			[customFetch]: this.fetcher,
		});
		return this.keys;
	}
	constructor(
		vault: ModelVault,
		private readonly fetcher: typeof fetch = fetch,
	) {
		super(vault);
	}

	async list(): Promise<ConnectionMetadata[]> {
		const [active, pending] = await Promise.all([
			this.vault.list(),
			this.vault.listPending(),
		]);
		const ids = new Set(active.map((r) => r.id));
		return [
			...active.map(metadata),
			...pending
				.filter((r) => !ids.has(r.id))
				.map((r) => ({
					id: r.id,
					clientId: r.clientId,
					createdAt: r.createdAt,
					name: "ChatGPT",
					preferred: false,
					authorized: false,
					planNoticeSeen: false,
					status: "pending" as const,
				})),
		].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	async connect(reconnectId?: string): Promise<{
		url: string;
		finished: Promise<ConnectionMetadata>;
		cancel: () => void;
	}> {
		const existing = reconnectId ? await this.vault.read(reconnectId) : null;
		const pending = reconnectId
			? await this.vault.readPending(reconnectId)
			: null;
		if (reconnectId && !existing && !pending)
			throw new ModelAuthError("unknown_registration");
		const host = await this.vault.hostId();
		const registrationId = existing?.id ?? pending?.id ?? randomUUID();
		const savedClientId = existing?.clientId ?? pending?.clientId;
		this.pending.get(registrationId)?.();
		const { state, verifier, challenge } = makePkce();
		const nonce = randomBytes(32).toString("base64url");
		let resolve!: (value: ConnectionMetadata) => void,
			reject!: (error: unknown) => void;
		const finished = new Promise<ConnectionMetadata>((yes, no) => {
			resolve = yes;
			reject = no;
		});

		void finished.catch(() => {});
		const exchangeAbort = new AbortController();
		let consumed = false;
		let cancelled = false;
		let redirect = "";
		const server = createServer((request, response) => {
			const callback = new URL(request.url ?? "/", redirect);
			if (request.method !== "GET" || callback.pathname !== "/auth/callback") {
				response.writeHead(404).end();
				return;
			}
			const receivedState = callback.searchParams.get("state") ?? "";
			if (
				consumed ||
				callback.searchParams.getAll("state").length !== 1 ||
				!same(state, receivedState)
			) {
				response.writeHead(400).end("Invalid authorization state.");
				return;
			}
			consumed = true;
			if (callback.searchParams.has("error")) {
				response
					.writeHead(400, { "Cache-Control": "no-store" })
					.end("Authorization was not completed. Return to Zuse to retry.");
				cleanup();
				reject(
					new ModelAuthError(
						callback.searchParams.get("error") === "access_denied"
							? "access_denied"
							: "invalid_callback",
					),
				);
				return;
			}
			const code = callback.searchParams.get("code");
			const clientId = callback.searchParams.get("client_id") ?? savedClientId;
			if (
				callback.searchParams.getAll("code").length !== 1 ||
				callback.searchParams.getAll("client_id").length > 1 ||
				callback.searchParams.has("error") ||
				!code ||
				!clientId ||
				clientId === "dynamic_agent_client" ||
				(savedClientId && clientId !== savedClientId)
			) {
				response.writeHead(400).end("Authorization was not completed.");
				cleanup();
				reject(new ModelAuthError("invalid_callback"));
				return;
			}
			void (async () => {
				if (!existing)
					await this.vault.lock(registrationId, async () => {
						if (cancelled) throw new ModelAuthError("cancelled");
						await this.vault.writePending({
							id: registrationId,
							clientId,
							createdAt: pending?.createdAt ?? Date.now(),
						});
					});
				return this.exchange(
					new URLSearchParams({
						grant_type: "authorization_code",
						client_id: clientId,
						code,
						code_verifier: verifier,
						redirect_uri: redirect,
						resource,
					}),
					exchangeAbort.signal,
				);
			})()
				.then(async (tokens) => {
					if (!tokens.id_token || tokens.scope === undefined)
						throw new ModelAuthError("missing_tokens");
					const identity = await jwtVerify(
						tokens.id_token,
						await this.signingKeys(),
						{
							issuer,
							audience: clientId,
							requiredClaims: ["exp", "iat", "sub", "nonce"],
						},
					);
					if (
						typeof identity.payload.nonce !== "string" ||
						!same(identity.payload.nonce, nonce) ||
						!identity.payload.sub ||
						(existing && existing.subject !== identity.payload.sub)
					)
						throw new ModelAuthError("identity_mismatch");
					const registration: ModelRegistration = {
						id: registrationId,
						clientId,
						subject: identity.payload.sub,
						...(typeof identity.payload.email === "string"
							? { email: identity.payload.email }
							: {}),
						name: existing?.name ?? "ChatGPT",
						createdAt: existing?.createdAt ?? pending?.createdAt ?? Date.now(),
						preferred: existing?.preferred ?? false,
						planNoticeSeen: existing?.planNoticeSeen,
						scope: tokens.scope ?? "",
						idToken: tokens.id_token,
						accessToken: tokens.access_token,
						refreshToken: tokens.refresh_token,
						expiresAt:
							tokens.expires_in === undefined
								? undefined
								: Date.now() + tokens.expires_in * 1000,
						earliestRefreshAt: refreshTimestamp(tokens.earliest_refresh_at),
					};
					await this.vault.lock(registration.id, async () => {
						if (cancelled) throw new ModelAuthError("cancelled");
						const current = await this.vault.read(registration.id);
						if (
							existing &&
							(current?.authorizationGeneration ?? 0) !==
								(existing.authorizationGeneration ?? 0)
						)
							throw new ModelAuthError("cancelled");
						registration.name = current?.name ?? registration.name;
						registration.preferred =
							current?.preferred ?? registration.preferred;
						registration.planNoticeSeen =
							current?.planNoticeSeen ?? registration.planNoticeSeen;
						registration.authorizationGeneration =
							(current?.authorizationGeneration ?? 0) + 1;
						await this.vault.write(registration);
						await this.vault.removePending(registration.id);
					});
					response
						.writeHead(200, {
							"Content-Type": "text/plain; charset=utf-8",
							"Cache-Control": "no-store",
						})
						.end("Connected to Zuse. You can close this window.");
					cleanup();
					resolve(metadata(registration));
				})
				.catch((error) => {
					response
						.writeHead(400)
						.end("Sign-in failed. Please return to Zuse and retry.");
					cleanup();
					reject(
						error instanceof ModelAuthError
							? error
							: new ModelAuthError("verification_failed"),
					);
				});
		});
		const cleanup = () => {
			clearTimeout(timeout);
			this.finishPending(registrationId, cancel);
			server.close();
		};
		const cancel = (code = "cancelled") => {
			cancelled = true;
			exchangeAbort.abort();
			cleanup();
			server.closeAllConnections();
			reject(new ModelAuthError(code));
		};
		const timeout = setTimeout(() => cancel("timeout"), 5 * 60_000);
		timeout.unref();
		this.replacePending(registrationId, cancel);
		await new Promise<void>((yes, no) => {
			server.once("error", no);
			server.listen(0, "127.0.0.1", yes);
		}).catch((error) => {
			cleanup();
			throw error;
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new ModelAuthError("loopback_unavailable");
		redirect = `http://127.0.0.1:${address.port}/auth/callback`;
		const url = new URL(`${issuer}/api/accounts/authorize`);
		url.search = new URLSearchParams({
			client_id: savedClientId ?? "dynamic_agent_client",
			...(!savedClientId
				? { agent_name_hint: "Zuse" }
				: existing?.email
					? { login_hint: existing.email }
					: {}),
			ext_agent_host_id: host,
			response_type: "code",
			redirect_uri: redirect,
			scope: scopes,
			resource,
			...(existing && !existing.scope.split(/\s+/).includes(planUsageScope)
				? { prompt: "consent" }
				: {}),
			state,
			nonce,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		return { url: url.href, finished, cancel };
	}
	private async exchange(body: URLSearchParams, signal?: AbortSignal) {
		const response = await postOAuthForm(
			this.fetcher,
			`${issuer}/api/accounts/oauth/token`,
			body,
			30000,
			signal,
		);
		if (!response.ok)
			throw new ModelAuthError(
				response.status === 400 || response.status === 401
					? "reauthorization_required"
					: "temporarily_unavailable",
			);
		const tokens = tokenSchema.parse(await response.json());
		const granted = tokens.scope?.split(/\s+/) ?? [];
		if (
			tokens.access_token &&
			(tokens.token_type?.toLowerCase() !== "bearer" ||
				tokens.expires_in === undefined)
		)
			throw new ModelAuthError("verification_failed");
		if (
			(body.get("grant_type") === "refresh_token" ||
				granted.includes("offline_access") ||
				granted.includes(planUsageScope)) &&
			(!tokens.access_token || !tokens.refresh_token)
		)
			throw new ModelAuthError("verification_failed");
		return tokens;
	}
	async credential(
		id: string,
	): Promise<{ connectionId: string; accessToken: string }> {
		return this.credentialWith(
			id,
			(value) => metadata(value).authorized,
			async (value) => {
				const tokens = await this.exchange(
					new URLSearchParams({
						grant_type: "refresh_token",
						client_id: value.clientId,
						refresh_token: value.refreshToken,
						resource,
					}),
				);
				if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in)
					throw new ModelAuthError("reauthorization_required");
				const refreshed = {
					...value,
					accessToken: tokens.access_token,
					refreshToken: tokens.refresh_token ?? value.refreshToken,
					expiresAt:
						tokens.expires_in === undefined
							? undefined
							: Date.now() + tokens.expires_in * 1000,
					earliestRefreshAt: refreshTimestamp(tokens.earliest_refresh_at),
					scope: tokens.scope ?? value.scope,
				};
				return refreshed;
			},
		);
	}
	async disconnect(id: string): Promise<{ revoked: boolean }> {
		return this.disconnectWith(id, async (value) => {
			const refreshToken = value.refreshToken;
			if (refreshToken)
				try {
					const discovery = await this.fetcher(
						`${issuer}/.well-known/openid-configuration`,
						{ signal: AbortSignal.timeout(5000), redirect: "error" },
					);
					const config = z
						.object({ revocation_endpoint: z.string().url().optional() })
						.parse(await discovery.json());
					if (
						config.revocation_endpoint &&
						new URL(config.revocation_endpoint).origin === issuer
					) {
						for (let attempt = 0; attempt < 2; attempt++) {
							try {
								const response = await this.fetcher(
									config.revocation_endpoint,
									{
										method: "POST",
										redirect: "error",
										headers: {
											"Content-Type": "application/x-www-form-urlencoded",
										},
										body: new URLSearchParams({
											token: refreshToken,
											token_type_hint: "refresh_token",
											client_id: value.clientId,
										}),
										signal: AbortSignal.timeout(5000),
									},
								);
								if (response.status === 200) return true;
								if (response.status < 500) return false;
							} catch {}
							if (attempt === 0) await delay(200);
						}
					}
				} catch {}
			return false;
		});
	}
}
