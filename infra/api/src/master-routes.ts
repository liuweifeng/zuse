import { MasterAuthorityCommand } from "@zuse/contracts";
import { Effect, Redacted, Schema } from "effect";
import { importJWK, type JWK, SignJWT } from "jose";
import { requireEnvironmentCredential } from "./auth.ts";
import { ApiConfiguration } from "./config.ts";
import {
	hasManagedPublicEndpoint,
	publicEndpoint,
} from "./environment-endpoint.ts";
import { conflict, forbidden, notFound } from "./errors.ts";
import { decodeBody, decodePathSegment, json } from "./http.ts";
import { ApiStore } from "./store.ts";

/** One account-owned generation fences dispatch across coordinator homes. */
export const routeMasterRequest = (request: Request) =>
	Effect.gen(function* () {
		const connect =
			/^\/v1\/environments\/([^/]+)\/masters\/([^/]+)\/connect$/.exec(
				new URL(request.url).pathname,
			);
		if (connect && request.method === "POST") {
			const source = yield* decodePathSegment(connect[1] ?? ""),
				masterId = yield* decodePathSegment(connect[2] ?? "");
			const principal = yield* requireEnvironmentCredential(request, source);
			const body = yield* decodeBody(
				Schema.Struct({ destination: Schema.String }),
				request,
			);
			const store = yield* ApiStore,
				config = yield* ApiConfiguration;
			const ownership = yield* store.getMasterOwnership(
				principal.accountId,
				masterId,
			);
			const destination = yield* store.getEnvironment(body.destination);
			if (
				!ownership ||
				!destination ||
				destination.accountId !== principal.accountId
			)
				return yield* Effect.fail(notFound("master_environment_not_found"));
			if (!hasManagedPublicEndpoint(destination))
				return yield* Effect.fail(conflict("master_tunnel_unavailable"));
			const now = Date.now(),
				expiresAt = now + config.connectTokenTtlMs;
			const token = yield* Effect.tryPromise({
				try: async () => {
					const key = await importJWK(
						JSON.parse(Redacted.value(config.mintPrivateKey)) as JWK,
						"EdDSA",
					);
					return new SignJWT({
						masterId,
						sourceEnvironmentId: source,
						environmentId: body.destination,
					})
						.setProtectedHeader({ alg: "EdDSA", typ: "master-peer+jwt" })
						.setIssuer(config.apiIssuer)
						.setAudience(`zuse-master:${body.destination}`)
						.setSubject(principal.accountId)
						.setIssuedAt(Math.floor(now / 1000))
						.setExpirationTime(Math.floor(expiresAt / 1000))
						.sign(key);
				},
				catch: () => forbidden("master_grant_failed"),
			});
			return json({
				endpoint: `${publicEndpoint(destination).httpBaseUrl}/master-peer`,
				token,
				expiresAt,
			});
		}
		const match =
			/^\/v1\/environments\/([^/]+)\/masters\/([^/]+)\/authority$/.exec(
				new URL(request.url).pathname,
			);
		if (!match || request.method !== "POST") return null;
		const environmentId = yield* decodePathSegment(match[1] ?? "");
		const masterId = yield* decodePathSegment(match[2] ?? "");
		const principal = yield* requireEnvironmentCredential(
			request,
			environmentId,
		);
		const command = yield* decodeBody(MasterAuthorityCommand, request);
		const store = yield* ApiStore;
		const current = yield* store.getMasterOwnership(
			principal.accountId,
			masterId,
		);
		if (command._tag === "read") return json({ ownership: current });
		if (current && current.homeEnvironmentId !== environmentId) {
			// A retried handoff may already belong to its destination.
			if (
				current.generation === command.expectedGeneration + 1 &&
				current.homeEnvironmentId === command.homeEnvironmentId &&
				JSON.stringify(current.repositories) ===
					JSON.stringify(command.repositories)
			)
				return json({ ownership: current });
			return yield* Effect.fail(forbidden("master_home_mismatch"));
		}
		if (!current && command.homeEnvironmentId !== environmentId)
			return yield* Effect.fail(forbidden("master_initial_home_mismatch"));
		for (const id of new Set([
			command.homeEnvironmentId,
			...command.repositories.map((repository) => repository.environmentId),
		])) {
			const environment = yield* store.getEnvironment(id);
			if (!environment || environment.accountId !== principal.accountId)
				return yield* Effect.fail(notFound("master_environment_not_found"));
		}
		const next = {
			masterId,
			homeEnvironmentId: command.homeEnvironmentId,
			generation: command.expectedGeneration + 1,
			repositories: command.repositories,
		};
		if (
			current &&
			current.generation === next.generation &&
			JSON.stringify(current) === JSON.stringify(next)
		)
			return json({ ownership: current });
		const applied = yield* store.compareMasterOwnership(
			principal.accountId,
			command.expectedGeneration,
			next,
		);
		if (!applied)
			return yield* Effect.fail(conflict("master_generation_conflict"));
		return json({ ownership: next });
	});
