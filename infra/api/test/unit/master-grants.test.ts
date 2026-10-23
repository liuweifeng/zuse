import { MasterPeerGrant } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { expect, it } from "vitest";
import { layer as configLayer } from "../../src/config.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { routeMasterRequest } from "../../src/master-routes.ts";
import { ApiStore, ApiStoreMemory } from "../../src/store.ts";

it("mints only account-scoped Master grants using an environment credential", async () => {
	const keys = await generateKeyPair("EdDSA", { extractable: true });
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			ApiStoreMemory,
			configLayer({
				apiIssuer: "https://api.test",
				workosJwksUrl: "https://auth.test/jwks",
				workosIssuer: "https://auth.test",
				mintPrivateKey: Redacted.make(
					JSON.stringify(await exportJWK(keys.privateKey)),
				),
				mintPublicKey: JSON.stringify(await exportJWK(keys.publicKey)),
			}),
		),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* ApiStore;
				for (const { environmentId, accountId } of [
					{ environmentId: "home", accountId: "account" },
					{ environmentId: "cloud", accountId: "account" },
					{ environmentId: "foreign", accountId: "other" },
				])
					yield* store.registerEnvironment(
						{
							environmentId,
							accountId,
							providerKind: "desktop",
							environmentPublicKey: "unused",
							httpBaseUrl: `https://${environmentId}.test`,
							wsBaseUrl: `wss://${environmentId}.test`,
							linkedAtMs: 0,
						},
						null,
						"replace-same-account",
					);
				yield* store.insertCredential({
					credentialId: "credential",
					environmentId: "home",
					accountId: "account",
					credentialHash: yield* sha256Hex("zenv_home"),
					createdAtMs: 0,
				});
				yield* store.compareMasterOwnership("account", 0, {
					masterId: "master",
					homeEnvironmentId: "home",
					generation: 1,
					repositories: [],
				});
			}),
		);
		const request = (destination: string, credential = "zenv_home") =>
			new Request(
				"https://api.test/v1/environments/home/masters/master/connect",
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${credential}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ destination }),
				},
			);
		const response = await runtime.runPromise(
			routeMasterRequest(request("cloud")),
		);
		expect(response?.status).toBe(200);
		const grant = Schema.decodeUnknownSync(MasterPeerGrant)(
			await response?.json(),
		);
		const verified = await jwtVerify(grant.token, keys.publicKey, {
			issuer: "https://api.test",
			audience: "zuse-master:cloud",
			typ: "master-peer+jwt",
		});
		expect(verified.payload.masterId).toBe("master");
		expect(verified.payload.sourceEnvironmentId).toBe("home");
		expect(grant.endpoint).toBe("https://cloud.test/master-peer");
		await expect(
			jwtVerify(grant.token, keys.publicKey, {
				audience: "zuse-env:cloud",
				typ: "connect+jwt",
			}),
		).rejects.toThrow();
		await expect(
			runtime.runPromise(routeMasterRequest(request("foreign"))),
		).rejects.toThrow();
		await expect(
			runtime.runPromise(routeMasterRequest(request("cloud", "zenv_invalid"))),
		).rejects.toThrow();
	} finally {
		await runtime.dispose();
	}
});
