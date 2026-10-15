import { useAtomValue } from "@effect/atom-react";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import {
	closeLocalProxy,
	type LocalProxy,
	type NearbyService,
	onLocalDiscoveryStateChanged,
	onLocalPathChanged,
	onNearbyServicesChanged,
	openLocalProxy,
	startLocalDiscovery,
	stopLocalDiscovery,
} from "../../modules/local-connectivity";
import {
	hasCurrentLocalRoute,
	openVerifiedLocalRoute,
} from "../lib/local-route";
import { verifyPinnedLocalServer } from "../lib/nearby-pairing";
import {
	applyConnectionOptions,
	getConnectionSnapshot,
	retryConnectionNow,
} from "../rpc/connection";
import {
	connectionsAtom,
	connectionsHydratedAtom,
	currentConnections,
	restorePairedConnectionRoutes,
	updateDiscoveredConnectionRoute,
} from "./connections";
import { registerLocalRouteRecovery } from "./local-route-recovery";
import { retryMobileClientBusConnections } from "./mobile-client-bus";
import { appAtomRegistry } from "./registry";

type ActiveRoute = {
	readonly routeId: string;
	readonly proxy: LocalProxy;
};

/**
 * Keeps stable paired environments attached to disposable Bonjour routes.
 * A path change (Wi-Fi switch) invalidates everything at once: proxies are
 * closed, the service cache is dropped (services discovered on the old
 * network are unreachable by definition), and the native side restarts the
 * Bonjour browser. When a fresh route lands, routeGeneration is bumped and
 * the connection supervisor is woken directly — recovery does not depend on
 * a screen being mounted or on the retry budget not being exhausted.
 */
export function useLocalConnectivityRuntime(): void {
	const hydrated = useAtomValue(connectionsHydratedAtom);
	const activeRoutes = useRef(new Map<string, ActiveRoute>());
	const services = useRef<readonly NearbyService[]>([]);

	const pathEpoch = useRef(0);
	const reconciling = useRef(false);
	const reconcileAgain = useRef(false);
	const requestedInitialPairing = useRef(false);

	useEffect(() => {
		if (!hydrated) return;
		let disposed = false;

		const fallBackToPairedRoutes = async (keys: ReadonlyArray<string>) => {
			const restored = await restorePairedConnectionRoutes(keys);
			for (const record of restored) {
				console.info("[zuse:nearby] route.paired_fallback", {
					connectionKey: record.key,
				});
				applyConnectionOptions(record);
				retryMobileClientBusConnections(record.key);
			}
		};

		const reconcile = async () => {
			if (disposed) return;
			if (reconciling.current) {
				reconcileAgain.current = true;
				return;
			}
			reconciling.current = true;
			try {
				do {
					reconcileAgain.current = false;
					const epoch = pathEpoch.current;
					const paired = currentConnections().filter(
						(connection) =>
							connection.source === "paired" &&
							(connection.nearbyServiceName !== undefined ||
								(connection.serverPublicKey !== undefined &&
									connection.transportCertificatePin !== undefined)),
					);
					console.info("[zuse:nearby] reconcile.pass", {
						paired: paired.map((connection) => connection.key),
						services: services.current.length,
					});
					const pairedKeys = new Set(
						paired.map((connection) => connection.key),
					);
					for (const [key, route] of activeRoutes.current) {
						if (pairedKeys.has(key)) continue;
						activeRoutes.current.delete(key);
						await closeLocalProxy(route.proxy.id);
					}
					for (const connection of paired) {
						const candidates =
							connection.serverPublicKey !== undefined &&
							connection.serverKeyPin !== undefined
								? services.current
								: services.current.filter(
										(candidate) =>
											candidate.name === connection.nearbyServiceName,
									);
						const current = activeRoutes.current.get(connection.key);
						console.info("[zuse:nearby] reconcile.connection", {
							connectionKey: connection.key,
							candidates: candidates.map((candidate) => ({
								name: candidate.name,
								routeId: candidate.routeId,
								interface: candidate.interfaceName ?? null,
							})),
							currentRouteId: current?.routeId ?? null,
							pinned: connection.serverPublicKey !== undefined,
						});
						if (
							(current !== undefined &&
								getConnectionSnapshot(connection).status === "connected") ||
							hasCurrentLocalRoute(current?.routeId, candidates)
						) {
							if (getConnectionSnapshot(connection).status === "error") {
								console.info("[zuse:nearby] route.current.nudge_exhausted", {
									connectionKey: connection.key,
								});
								retryConnectionNow(connection);
							}
							continue;
						}
						let selected:
							| { readonly service: NearbyService; readonly proxy: LocalProxy }
							| undefined;
						for (const service of candidates) {
							try {
								const serverPublicKey = connection.serverPublicKey;
								const serverKeyPin = connection.serverKeyPin;
								const securedService = {
									...service,
									tlsCertificatePin:
										connection.transportCertificatePin ??
										service.tlsCertificatePin,
								};
								const proxy =
									serverPublicKey !== undefined && serverKeyPin !== undefined
										? await openVerifiedLocalRoute({
												service: securedService,
												open: openLocalProxy,
												close: (candidate) => closeLocalProxy(candidate.id),
												verify: (candidate) =>
													verifyPinnedLocalServer({
														host: candidate.host,
														port: candidate.port,
														publicKey: serverPublicKey,
														pin: serverKeyPin,
													}),
											})
										: await openLocalProxy(securedService);
								selected = { service, proxy };
								break;
							} catch (cause) {
								console.warn("[zuse:nearby] route.candidate.failed", {
									connectionKey: connection.key,
									service: service.name,
									interface: service.interfaceName ?? null,
									reason:
										cause instanceof Error ? cause.message : String(cause),
								});
							}
						}
						if (selected === undefined) {
							console.info("[zuse:nearby] route.unresolved", {
								connectionKey: connection.key,
								candidateCount: candidates.length,
							});

							if (
								current !== undefined &&
								getConnectionSnapshot(connection).status !== "connected"
							) {
								activeRoutes.current.delete(connection.key);
								await closeLocalProxy(current.proxy.id).catch(() => {});
							}
							if (!activeRoutes.current.has(connection.key))
								await fallBackToPairedRoutes([connection.key]);
							continue;
						}
						if (pathEpoch.current !== epoch) {
							await closeLocalProxy(selected.proxy.id).catch(() => {});
							reconcileAgain.current = true;
							break;
						}
						const { service, proxy } = selected;
						activeRoutes.current.set(connection.key, {
							routeId: service.routeId,
							proxy,
						});
						console.info("[zuse:nearby] route.replaced", {
							connectionKey: connection.key,
							previousRouteId: current?.routeId ?? null,
							nextRouteId: service.routeId,
							proxyPort: proxy.port,
						});
						await updateDiscoveredConnectionRoute({
							key: connection.key,
							host: proxy.host,
							port: proxy.port,
							pathType: service.interfaceName?.startsWith("awdl")
								? "apple-peer"
								: "lan",
							nearbyServiceName: service.name,
							transportCertificatePin:
								connection.transportCertificatePin ?? service.tlsCertificatePin,
						});

						const updated = currentConnections().find(
							(record) => record.key === connection.key,
						);
						if (updated !== undefined) {
							applyConnectionOptions(updated);
							retryMobileClientBusConnections(connection.key);
						}
						if (current !== undefined) await closeLocalProxy(current.proxy.id);
					}
				} while (reconcileAgain.current && !disposed);
			} finally {
				reconciling.current = false;
			}
		};

		const invalidateRoutes = async (key?: string) => {
			pathEpoch.current += 1;

			services.current = [];
			const current = [...activeRoutes.current.entries()].filter(
				([routeKey]) => key === undefined || routeKey === key,
			);
			for (const [routeKey] of current) activeRoutes.current.delete(routeKey);
			await Promise.allSettled(
				current.map(([, route]) => closeLocalProxy(route.proxy.id)),
			);

			await fallBackToPairedRoutes(
				key === undefined
					? currentConnections().map((connection) => connection.key)
					: [key],
			);
		};

		let restartingDiscovery = false;

		let suppressNextPathRestart = true;
		let lastPathRestartAt = 0;
		const restartDiscovery = async (key?: string) => {
			if (disposed) return;
			await invalidateRoutes(key);
			if (restartingDiscovery) return;
			console.info("[zuse:nearby] discovery.restart");
			restartingDiscovery = true;
			try {
				await stopLocalDiscovery().catch(() => {});
				suppressNextPathRestart = true;
				await startLocalDiscovery().catch(() => {});
			} finally {
				restartingDiscovery = false;
			}
			void reconcile();
		};
		const removeRecovery = registerLocalRouteRecovery((key) => {
			console.info("[zuse:nearby] route.recovery.requested", {
				connectionKey: key,
			});
			void restartDiscovery(key);
		});

		void startLocalDiscovery();
		const removeServices = onNearbyServicesChanged((next) => {
			console.info("[zuse:nearby] services.changed", {
				count: next.length,
				names: next.map((service) => service.name),
			});
			services.current = next;
			if (
				next.length > 0 &&
				!requestedInitialPairing.current &&
				currentConnections().length === 0
			) {
				requestedInitialPairing.current = true;
				router.push("/connect/nearby");
			}
			void reconcile();
		});
		const removePath = onLocalPathChanged((event) => {
			console.info("[zuse:nearby] path.changed", {
				status: event.status,
				usesWifi: event.usesWifi,
				generation: event.generation,
			});
			if (suppressNextPathRestart) {
				suppressNextPathRestart = false;
				void reconcile();
				return;
			}
			const now = Date.now();
			if (now - lastPathRestartAt < 10_000) {
				void reconcile();
				return;
			}
			lastPathRestartAt = now;
			void restartDiscovery();
		});

		let unhealthyRestartTimer: ReturnType<typeof setTimeout> | null = null;
		let unhealthyRestartCount = 0;
		const removeDiscoveryState = onLocalDiscoveryStateChanged((state) => {
			console.info("[zuse:nearby] discovery.state", state);
			if (state.state === "waiting" || state.state === "failed") {
				const delay = Math.min(24_000, 3_000 * 2 ** unhealthyRestartCount);
				unhealthyRestartTimer ??= setTimeout(() => {
					unhealthyRestartTimer = null;
					unhealthyRestartCount += 1;
					void restartDiscovery();
				}, delay);
				return;
			}
			if (state.state === "ready") {
				unhealthyRestartCount = 0;
				if (unhealthyRestartTimer !== null) {
					clearTimeout(unhealthyRestartTimer);
					unhealthyRestartTimer = null;
				}
			}
		});

		let backgrounded = false;
		const appStateSubscription = AppState.addEventListener(
			"change",
			(state) => {
				if (state === "background") {
					backgrounded = true;
					pathEpoch.current += 1;
					services.current = [];
					activeRoutes.current.clear();
					return;
				}
				if (state === "active" && backgrounded) {
					backgrounded = false;
					void restartDiscovery();
				}
			},
		);
		const removeConnections = appAtomRegistry.subscribe(
			connectionsAtom,
			() => {
				void reconcile();
			},
			{ immediate: true },
		);
		void reconcile();

		return () => {
			disposed = true;
			removeRecovery();
			removeServices();
			removePath();
			removeDiscoveryState();
			if (unhealthyRestartTimer !== null) clearTimeout(unhealthyRestartTimer);
			appStateSubscription.remove();
			removeConnections();
			for (const route of activeRoutes.current.values()) {
				void closeLocalProxy(route.proxy.id);
			}
			activeRoutes.current.clear();
			void stopLocalDiscovery();
		};
	}, [hydrated]);
}
