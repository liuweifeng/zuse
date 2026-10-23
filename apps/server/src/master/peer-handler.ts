import { MasterError, MasterPeerOperation } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { importJWK, type JWK, jwtVerify } from "jose";
import { LanAuthService } from "../lan-auth/services/lan-auth-service.ts";
import { MasterService } from "./service.ts";
import { masterFailure } from "./store.ts";

/** This capability is accepted only here, never by the ordinary RPC transport. */
export const receiveMasterPeer = (token: string, body: string) =>
	Effect.gen(function* () {
		const auth = yield* LanAuthService,
			service = yield* MasterService;
		const config = yield* auth.getApiConfig();
		if (!config?.mintPublicKey)
			return yield* Effect.fail(
				new MasterError({
					reason: "Zot peer authentication is unavailable.",
				}),
			);
		const mintPublicKey = config.mintPublicKey;
		const claims = yield* Effect.tryPromise({
			try: async () => {
				const key = await importJWK(JSON.parse(mintPublicKey) as JWK, "EdDSA");
				const { payload } = await jwtVerify(token, key, {
					issuer: config.apiIssuer,
					audience: `zuse-master:${config.environmentId}`,
					typ: "master-peer+jwt",
				});
				return Schema.decodeUnknownSync(
					Schema.Struct({
						masterId: Schema.String,
						sourceEnvironmentId: Schema.String,
						environmentId: Schema.String,
					}),
				)(payload);
			},
			catch: masterFailure,
		});
		const operation = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(MasterPeerOperation),
		)(body);
		const masterId =
			operation._tag === "target"
				? operation.input.masterId
				: operation._tag === "stage"
					? operation.transfer.master.id
					: operation.masterId;
		if (
			claims.masterId !== masterId ||
			claims.environmentId !== config.environmentId
		)
			return yield* Effect.fail(
				new MasterError({ reason: "Zot peer scope mismatch." }),
			);
		switch (operation._tag) {
			case "probe":
				return { ok: true };
			case "target":
				if (operation.input.homeEnvironmentId !== claims.sourceEnvironmentId)
					return yield* Effect.fail(
						new MasterError({ reason: "Zot dispatch source mismatch." }),
					);
				return yield* service.target(operation.input);
			case "stage":
				if (
					operation.transfer.master.homeEnvironmentId !==
					claims.sourceEnvironmentId
				)
					return yield* Effect.fail(
						new MasterError({ reason: "Zot transfer source mismatch." }),
					);
				return yield* service.transfer(operation.commandId, operation.transfer);
			case "activate":
				return yield* service.activate(masterId, operation.commandId);
			case "workerQuery":
				if (operation.environmentId !== claims.sourceEnvironmentId)
					return yield* Effect.fail(
						new MasterError({ reason: "Zot report source mismatch." }),
					);
				return yield* service.workerQuery(
					masterId,
					operation.environmentId,
					operation.sessionId,
					operation.query,
				);
		}
	}).pipe(Effect.mapError(masterFailure));
