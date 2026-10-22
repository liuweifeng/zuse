import {
	Master,
	type MasterPeerGrant,
	type MasterPeerOperation,
	type MasterQuery,
	type MasterTargetRequest,
	MasterTargetResult,
	type MasterTransfer,
} from "@zuse/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { ApiLinkService } from "../api/api-link-service.ts";
import { masterFailure } from "./store.ts";

/** Scoped HTTP peer grants use environment credentials, including on unattended homes. */
const makeMasterPeers = Effect.gen(function* () {
	const api = yield* ApiLinkService;
	const grants = new Map<string, MasterPeerGrant>();
	const call = <A, I>(
		destination: string,
		masterId: string,
		operation: MasterPeerOperation,
		schema: Schema.Codec<A, I>,
	) =>
		Effect.gen(function* () {
			const key = `${masterId}:${destination}`;
			let grant = grants.get(key);
			if (!grant || grant.expiresAt < Date.now() + 5000) {
				grant = yield* api.masterConnect(masterId, destination);
				grants.set(key, grant);
			}
			const current = grant;
			const value = yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(current.endpoint, {
						method: "POST",
						headers: {
							authorization: `Bearer ${current.token}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(operation),
						signal: AbortSignal.timeout(30_000),
					});
					if (!response.ok) {
						grants.delete(key);
						throw new Error(
							`Zot peer rejected delivery (${response.status}). It will reconcile with the original environment.`,
						);
					}
					return response.json();
				},
				catch: masterFailure,
			});
			return yield* Schema.decodeUnknownEffect(schema)(value);
		}).pipe(Effect.mapError(masterFailure));
	return {
		probe: (destination: string, masterId: string) =>
			call(
				destination,
				masterId,
				{ _tag: "probe", masterId },
				Schema.Struct({ ok: Schema.Boolean }),
			).pipe(Effect.asVoid),
		target: (destination: string, input: MasterTargetRequest) =>
			call(
				destination,
				input.masterId,
				{ _tag: "target", input },
				MasterTargetResult,
			),
		stage: (destination: string, commandId: string, transfer: MasterTransfer) =>
			call(
				destination,
				transfer.master.id,
				{ _tag: "stage", commandId, transfer },
				Master,
			),
		activate: (destination: string, masterId: string, commandId: string) =>
			call(
				destination,
				masterId,
				{ _tag: "activate", masterId, commandId },
				Master,
			),
		workerQuery: (
			destination: string,
			masterId: string,
			environmentId: string,
			sessionId: string,
			query: MasterQuery,
		) =>
			call(
				destination,
				masterId,
				{ _tag: "workerQuery", masterId, environmentId, sessionId, query },
				Schema.Struct({ json: Schema.String }),
			),
	};
});
export class MasterPeers extends Context.Service<
	MasterPeers,
	Effect.Success<typeof makeMasterPeers>
>()("zuse/MasterPeers") {}
export const MasterPeersLive = Layer.effect(MasterPeers, makeMasterPeers);
