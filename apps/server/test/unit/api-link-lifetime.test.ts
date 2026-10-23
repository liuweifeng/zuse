import { EnvironmentId } from "@zuse/contracts";
import { Context, Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it, vi } from "vitest";
import { AccountAccessService } from "../../src/account-access/service.ts";
import {
	ApiLinkService,
	ApiLinkServiceLive,
} from "../../src/api/api-link-service.ts";
import { ManagedTunnelRuntime } from "../../src/api/managed-tunnel-runtime.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import {
	LanAuthConfig,
	LanAuthService,
} from "../../src/lan-auth/services/lan-auth-service.ts";
import { TelemetryStore } from "../../src/observability/telemetry-store.ts";

const makeLinkedLayer = (
	connectorToken?: string,
	start = () => Effect.void,
	clearApiConfig: LanAuthService["Service"]["clearApiConfig"] = () =>
		Effect.void,
) =>
	ApiLinkServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(LanAuthService, {
					clearApiConfig,
					getApiConfig: (): ReturnType<
						LanAuthService["Service"]["getApiConfig"]
					> =>
						Effect.succeed({
							apiUrl: "https://example.invalid",
							environmentId: EnvironmentId.make("lifetime-test"),
							apiIssuer: "test",
							label: undefined,
							connectorToken,
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
				Layer.succeed(AuthService, {
					getAccessToken: (): ReturnType<
						AuthService["Service"]["getAccessToken"]
					> => Effect.succeed("test-access"),
				} as AuthService["Service"]),
				Layer.succeed(
					AccountAccessService,
					{} as AccountAccessService["Service"],
				),
				Layer.succeed(ManagedTunnelRuntime, {
					start,
					stop: () => Effect.void,
				}),
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
					yield* Layer.build(makeLinkedLayer());
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
					yield* Layer.build(makeLinkedLayer());
					yield* Deferred.await(started);
					expect(requestSignal?.aborted).toBe(false);
				}),
			);
			expect(requestSignal?.aborted).toBe(true);
		}),
	);
});

it("boots a linked profile while tunnel reconciliation is offline", async () => {
	const signals: AbortSignal[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((_url: string, options: RequestInit) => {
			if (options.signal) signals.push(options.signal);
			return new Promise<Response>(() => {});
		}),
	);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					makeLinkedLayer("connector-token"),
				).pipe(Effect.timeout("2 seconds"));
				const status = yield* Context.get(context, ApiLinkService).status();
				expect(status.linked).toBe(true);
				expect(status.heartbeatActive).toBe(true);
				yield* Effect.yieldNow;
			}),
		),
	);
	expect(signals.length).toBeGreaterThan(0);
	expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it("aborts a stalled heartbeat and resumes periodic presence reporting", async () => {
	const signals: AbortSignal[] = [];
	const fetch = vi.fn((_url: string, options: RequestInit) => {
		if (options.signal) signals.push(options.signal);
		return signals.length === 1
			? new Promise<Response>(() => {})
			: Promise.resolve(Response.json({}));
	});
	vi.stubGlobal("fetch", fetch);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* Layer.build(makeLinkedLayer());
				yield* TestClock.adjust("11 seconds");
				expect(signals[0]?.aborted).toBe(true);
				yield* TestClock.adjust("30 seconds");
				expect(fetch).toHaveBeenCalledTimes(2);
			}),
		).pipe(Effect.provide(TestClock.layer())),
	);
});

it("cancels pending account inventory requests when their caller disconnects", async () => {
	let requestSignal: AbortSignal | undefined;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				vi.stubGlobal(
					"fetch",
					vi.fn((_url: string, options: RequestInit) => {
						if (options.method === "POST")
							return Promise.resolve(Response.json({}));
						requestSignal = options.signal ?? undefined;
						Effect.runSync(Deferred.succeed(started, undefined));
						return new Promise<Response>(() => {});
					}),
				);
				const context = yield* Layer.build(makeLinkedLayer());
				const request = yield* Effect.forkChild(
					Context.get(context, ApiLinkService).listEnvironments(),
				);
				yield* Deferred.await(started);
				yield* Fiber.interrupt(request);
				expect(requestSignal?.aborted).toBe(true);
			}),
		),
	);
});

it("unlinks during offline restoration without starting the old tunnel afterward", async () => {
	const start = vi.fn(() => Effect.void);
	const clear = vi.fn(() => Effect.void);
	const signals: AbortSignal[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((_url: string, options: RequestInit) => {
			if (options.signal) signals.push(options.signal);
			return new Promise<Response>(() => {});
		}),
	);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					makeLinkedLayer("old-token", start, clear),
				);
				const unlink = yield* Effect.forkChild(
					Context.get(context, ApiLinkService).unlink(),
				);
				yield* TestClock.adjust("11 seconds");
				yield* Fiber.join(unlink);
				expect(clear).toHaveBeenCalledOnce();
				yield* TestClock.adjust("1 minute");
				expect(start).not.toHaveBeenCalled();
				expect(signals.every((signal) => signal.aborted)).toBe(true);
			}),
		).pipe(Effect.provide(TestClock.layer())),
	);
});

it("aborts shared DPoP token refresh when the linked service closes", async () => {
	let requestSignal: AbortSignal | undefined;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				vi.stubGlobal(
					"fetch",
					vi.fn((url: string, options: RequestInit) => {
						if (String(url).includes("heartbeat"))
							return Promise.resolve(Response.json({}));
						requestSignal = options.signal ?? undefined;
						Effect.runSync(Deferred.succeed(started, undefined));
						return new Promise<Response>(() => {});
					}),
				);
				const context = yield* Layer.build(makeLinkedLayer());
				yield* Effect.forkChild(
					Context.get(context, ApiLinkService).connectEnvironment(
						EnvironmentId.make("remote"),
					),
				);
				yield* Deferred.await(started);
			}),
		),
	);
	expect(requestSignal?.aborted).toBe(true);
});

it("aborts a remote connect request when its caller disconnects", async () => {
	let requestSignal: AbortSignal | undefined;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				vi.stubGlobal(
					"fetch",
					vi.fn((url: string, options: RequestInit) => {
						if (String(url).includes("connect")) {
							requestSignal = options.signal ?? undefined;
							Effect.runSync(Deferred.succeed(started, undefined));
							return new Promise<Response>(() => {});
						}
						return Promise.resolve(
							Response.json({ accessToken: "dpop-test", expiresIn: 60000 }),
						);
					}),
				);
				const context = yield* Layer.build(makeLinkedLayer());
				const request = yield* Effect.forkChild(
					Context.get(context, ApiLinkService).connectEnvironment(
						EnvironmentId.make("remote"),
					),
				);
				yield* Deferred.await(started);
				yield* Fiber.interrupt(request);
				expect(requestSignal?.aborted).toBe(true);
			}),
		),
	);
});

it("expires a hung DPoP refresh and lets a later connection retry", async () => {
	let tokenRequests = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, options: RequestInit) => {
			if (String(url).includes("token")) {
				tokenRequests += 1;
				if (tokenRequests === 1)
					return new Promise<Response>((_resolve, reject) => {
						options.signal?.addEventListener("abort", () =>
							reject(options.signal?.reason),
						);
					});
			}
			return Promise.resolve(
				Response.json({ accessToken: "dpop-test", expiresIn: 60000 }),
			);
		}),
	);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(makeLinkedLayer());
				const service = Context.get(context, ApiLinkService);
				const result = yield* Effect.result(
					service.connectEnvironment(EnvironmentId.make("remote")),
				);
				expect(result._tag).toBe("Failure");
				yield* service.connectEnvironment(EnvironmentId.make("remote"));
				expect(tokenRequests).toBe(2);
			}),
		),
	);
}, 15_000);

it("cancels old account connections before unlinking", async () => {
	let requestSignal: AbortSignal | undefined;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				vi.stubGlobal(
					"fetch",
					vi.fn((url: string, options: RequestInit) => {
						if (String(url).includes("token")) {
							requestSignal = options.signal ?? undefined;
							Effect.runSync(Deferred.succeed(started, undefined));
							return new Promise<Response>((_resolve, reject) => {
								requestSignal?.throwIfAborted();
								requestSignal?.addEventListener("abort", () =>
									reject(requestSignal?.reason),
								);
							});
						}
						return Promise.resolve(Response.json({}));
					}),
				);
				const context = yield* Layer.build(makeLinkedLayer());
				const service = Context.get(context, ApiLinkService);
				const connecting = yield* Effect.forkChild(
					Effect.result(
						service.connectEnvironment(EnvironmentId.make("remote")),
					),
				);
				yield* Deferred.await(started);
				yield* service.unlink();
				expect(requestSignal?.aborted).toBe(true);
				expect((yield* Fiber.join(connecting))._tag).toBe("Failure");
			}),
		),
	);
});
