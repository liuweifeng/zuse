import { EnvironmentId } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { LanAuthService } from "../../src/lan-auth/services/lan-auth-service.ts";
import { receiveMasterPeer } from "../../src/master/peer-handler.ts";
import { MasterService } from "../../src/master/service.ts";

const stub = <T extends object>(partial: Partial<T>): T =>
	new Proxy(partial, {
		get(target, key) {
			if (key in target) return Reflect.get(target, key);
			return () => {
				throw new Error("Unexpected dispatch");
			};
		},
	}) as T;
it("rejects wrong Master, source, expiration and ordinary app tokens before dispatch", async () => {
	const keys = await generateKeyPair("EdDSA", { extractable: true });
	const publicKey = JSON.stringify(await exportJWK(keys.publicKey));
	const services = Layer.mergeAll(
		Layer.succeed(MasterService, stub<typeof MasterService.Service>({})),
		Layer.succeed(
			LanAuthService,
			stub<typeof LanAuthService.Service>({
				getApiConfig: () =>
					Effect.succeed({
						apiUrl: "https://api.test",
						apiIssuer: "https://api.test",
						environmentId: EnvironmentId.make("cloud"),
						environmentCredential: "private",
						label: undefined,
						connectorToken: undefined,
						tunnelHostname: undefined,
						mintPublicKey: publicKey,
					}),
			}),
		),
	);
	const token = (
		type = "master-peer+jwt",
		expiry = Math.floor(Date.now() / 1000) + 60,
	) =>
		new SignJWT({
			masterId: "master",
			sourceEnvironmentId: "home",
			environmentId: "cloud",
		})
			.setProtectedHeader({ alg: "EdDSA", typ: type })
			.setIssuer("https://api.test")
			.setAudience("zuse-master:cloud")
			.setExpirationTime(expiry)
			.sign(keys.privateKey);
	const call = async (credential: string, body: unknown) =>
		Effect.runPromise(
			receiveMasterPeer(credential, JSON.stringify(body)).pipe(
				Effect.provide(services),
			),
		);
	const valid = await token();
	expect(await call(valid, { _tag: "probe", masterId: "master" })).toEqual({
		ok: true,
	});
	await expect(
		call(valid, { _tag: "probe", masterId: "other" }),
	).rejects.toThrow();
	await expect(
		call(await token("connect+jwt"), { _tag: "probe", masterId: "master" }),
	).rejects.toThrow();
	await expect(
		call(await token("master-peer+jwt", 1), {
			_tag: "probe",
			masterId: "master",
		}),
	).rejects.toThrow();
	await expect(
		call(valid, {
			_tag: "target",
			input: {
				masterId: "master",
				commandId: "command",
				homeEnvironmentId: "other",
				generation: 1,
				folderId: "repo",
				action: { _tag: "catalog" },
			},
		}),
	).rejects.toThrow();
	await expect(
		call(valid, {
			_tag: "workerQuery",
			masterId: "master",
			environmentId: "spoofed",
			sessionId: "worker",
			query: { _tag: "state" },
		}),
	).rejects.toThrow();
});
