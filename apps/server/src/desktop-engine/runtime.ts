import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AuthFlowError } from "@zuse/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { type MainLayerDeps, makeMainLayer } from "../runtime.ts";
import { wsServerProtocolLayer } from "../transports/ws.ts";
import type { DesktopEngineConfig } from "./config.ts";
import { publishEngineEndpoint, removeEngineEndpoint } from "./endpoint.ts";
import { EngineHost } from "./host.ts";
import { localEngineProtocolLayer } from "./protocol.ts";

export const runDesktopEngine = (
	config: DesktopEngineConfig,
	native: Pick<
		MainLayerDeps,
		"credentialsLayer" | "modelConnectionMasterKey" | "onActiveTurns"
	> & {
		readonly onRemoteConnection?: () => () => void;
	},
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const token = randomBytes(32).toString("hex");
			const host = new EngineHost();
			const listening = yield* Deferred.make<number>();
			const ready = yield* Deferred.make<void>();
			const diagnostic = (event: string, fields?: Record<string, unknown>) =>
				host.notify("diagnostic", { event, fields });
			const layer = makeMainLayer({
				...native,
				userData: config.userData,
				telemetryIdentity: { kind: "desktop", instance: "local" },
				autoApiLink: { apiUrl: config.apiUrl },
				folderPicker: {
					pick: () =>
						Effect.tryPromise((signal) =>
							host.request("pickFolder", null, signal),
						).pipe(
							Effect.map((value) => (typeof value === "string" ? value : null)),
							Effect.orElseSucceed(() => null),
						),
				},
				authShell: {
					get redirectUri() {
						return host.redirectUri;
					},
					get linearRedirectUri() {
						return host.linearRedirectUri;
					},
					open: (url) =>
						Effect.tryPromise({
							try: (signal) => host.request("openExternal", url, signal),
							catch: () =>
								new AuthFlowError({
									reason:
										"The desktop could not open the sign-in browser. Open the desktop app and try again.",
								}),
						}).pipe(Effect.asVoid),
					onCallbackUrl: (callback) =>
						Effect.sync(() => host.onCallback("account", callback)),
					onLinearCallbackUrl: (callback) =>
						Effect.sync(() => host.onCallback("linear", callback)),
				},
				serverProtocol: localEngineProtocolLayer({
					token,
					host,
					onListening: (port) =>
						Effect.runPromise(Deferred.succeed(listening, port)).then(() => {}),
				}),
				additionalServerProtocols: [
					wsServerProtocolLayer({
						port: config.apiPort,
						host: config.bindHost,
						staticDir: config.staticDir,
						devServerUrl: config.devServerUrl,
						onDiagnostic: diagnostic,
						onAuthenticatedConnection: native.onRemoteConnection,
					}),
					...(config.nearbyTls === undefined
						? []
						: [
								wsServerProtocolLayer({
									port: 0,
									host:
										process.platform === "linux"
											? config.bindHost
											: "127.0.0.1",
									tls: config.nearbyTls,
									onAuthenticatedConnection: native.onRemoteConnection,
									onListening: (address) =>
										host.notify("diagnostic", {
											event: "engine.nearby.listening",
											fields: {
												port: address.port,
												pin: config.nearbyTls?.pin,
											},
										}),
								}),
							]),
				],
				openHostSession: (sessionId, chatId) =>
					host.notify("openSession", { sessionId, chatId }),
				lanAuth: {
					policy: "protected",
					advertisedHost: config.advertisedHost,
					port: config.apiPort,
					pairingBootstrap: false,
					transportCertificatePin: config.nearbyTls?.pin,
					onNearbyPairingRequest: (request) =>
						host.notify("pairingRequest", request),
				},
				cliAccess: {
					path:
						config.cliAccessPath ?? join(config.userData, "cli-access.json"),
					wsUrl: `ws://127.0.0.1:${config.apiPort}/rpc`,
				},
				onStartupPhase: (phase) => {
					diagnostic(`engine.startup.${phase}`);
				},
			});
			const runtime = yield* Effect.gen(function* () {
				yield* Layer.build(layer);
				yield* Deferred.succeed(ready, undefined);
				return yield* Effect.never;
			}).pipe(Effect.forkScoped);
			// Never publish an attachable endpoint until database ownership, migrations and projections are ready.
			const [port] = yield* Effect.raceFirst(
				Effect.all([Deferred.await(listening), Deferred.await(ready)]),
				Fiber.join(runtime),
			);
			yield* Effect.acquireRelease(
				Effect.tryPromise(() =>
					publishEngineEndpoint(config.userData, {
						token,
						port,
						pid: process.pid,
						appVersion: config.appVersion,
						apiPort: config.apiPort,
					}),
				),
				() =>
					Effect.promise(() => removeEngineEndpoint(config.userData, token)),
			);
			yield* Fiber.join(runtime);
		}),
	);

export { readDesktopEngineConfig } from "./config.ts";
