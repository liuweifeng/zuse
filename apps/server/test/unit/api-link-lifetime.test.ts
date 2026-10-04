import { EnvironmentId } from "@zuse/contracts";
import { Deferred, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it, vi } from "vitest";
import { AccountAccessService } from "../../src/account-access/service.ts";
import { ApiLinkServiceLive } from "../../src/api/api-link-service.ts";
import { ManagedTunnelRuntime } from "../../src/api/managed-tunnel-runtime.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import {
	LanAuthConfig,
	LanAuthService,
} from "../../src/lan-auth/services/lan-auth-service.ts";
import { TelemetryStore } from "../../src/observability/telemetry-store.ts";

// Only booting an already-linked account is exercised; unexpected service calls fail.
const linkedLayer = ApiLinkServiceLive.pipe(
	Layer.provide(
		Layer.mergeAll(
			Layer.succeed(LanAuthService, {
				getApiConfig: (): ReturnType<
					LanAuthService["Service"]["getApiConfig"]
				> =>
					Effect.succeed({
						apiUrl: "https://example.invalid",
						environmentId: EnvironmentId.make("lifetime-test"),
						apiIssuer: "test",
						label: undefined,
						connectorToken: undefined,
						tunnelHostname: undefined,
						mintPublicKey: undefined,
						environmentCredential: "test-credential",
					}),
			} as LanAuthService["Service"]),
			Layer.succeed(LanAuthConfig, {
				policy: "protected",
				advertisedHost: null,
				port: null,
				pairingBootstrap: false,
			}),
			Layer.succeed(AuthService, {} as AuthService["Service"]),
			Layer.succeed(
				AccountAccessService,
				{} as AccountAccessService["Service"],
			),
			Layer.succeed(
				ManagedTunnelRuntime,
				{} as ManagedTunnelRuntime["Service"],
			),
			Layer.succeed(TelemetryStore, {
				record: (
					_event: Parameters<TelemetryStore["Service"]["record"]>[0],
				): void => {},
				runId: "lifetime-test",
			} as TelemetryStore["Service"]),
		),
	),
);

afterEach(() => vi.unstubAllGlobals());

it("stops an existing account's heartbeat when its service scope closes", async () => {
	const fetch = vi.fn(async () => Response.json({}));
	vi.stubGlobal("fetch", fetch);
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* Layer.build(linkedLayer);
					yield* TestClock.adjust("31 seconds");
					expect(fetch).toHaveBeenCalledTimes(2);
				}),
			);
			yield* TestClock.adjust("2 minutes");
			expect(fetch).toHaveBeenCalledTimes(2);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

it("aborts an in-flight heartbeat request when the service closes", async () => {
	let requestSignal: AbortSignal | undefined;
	await Effect.runPromise(
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			vi.stubGlobal(
				"fetch",
				vi.fn((_url: string, options: RequestInit) => {
					requestSignal = options.signal ?? undefined;
					Effect.runSync(Deferred.succeed(started, undefined));
					return new Promise<Response>((_resolve, reject) => {
						requestSignal?.addEventListener("abort", () =>
							reject(requestSignal?.reason),
						);
					});
				}),
			);
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* Layer.build(linkedLayer);
					yield* Deferred.await(started);
					expect(requestSignal?.aborted).toBe(false);
				}),
			);
			expect(requestSignal?.aborted).toBe(true);
		}),
	);
});
