import type { PreviewServer } from "@zuse/contracts";

export type DiscoveredPreview = Pick<
	PreviewServer,
	"name" | "port" | "loopbackOnly" | "isWebServer"
> & {
	readonly publicUrl?: string;
	readonly explicitlyRequested?: boolean;
	readonly localUrl?: string;
	readonly forwardingState?: "pending" | "ready" | "failed";
	readonly publicationState?: "pending" | "ready" | "failed";
};

export const EMPTY_PREVIEWS: ReadonlyArray<DiscoveredPreview> = [];

/** One poller per environment, shared by the chat and its browser panel. */
export const createPreviewDiscovery = (dependencies: {
	readonly list: () => Promise<ReadonlyArray<DiscoveredPreview>>;
	readonly publish?: (port: number) => Promise<string>;
	readonly forward?: (port: number) => Promise<number>;
	readonly onIdle?: () => void;
}) => {
	let snapshot = EMPTY_PREVIEWS;
	const eligible = (server: DiscoveredPreview) =>
		server.port >= 1024 &&
		(server.isWebServer === true || server.explicitlyRequested === true);
	const localUrls = new Map<number, string>();
	const failedForwards = new Set<number>();
	const listeners = new Set<() => void>();
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	const urls = new Map<number, string>();
	const failedPorts = new Set<number>();
	const update = (servers: ReadonlyArray<DiscoveredPreview>) => {
		const next = servers.map((server) => ({
			...server,
			publicUrl: urls.get(server.port),
			localUrl: localUrls.get(server.port),
			forwardingState:
				dependencies.forward === undefined || !eligible(server)
					? undefined
					: localUrls.has(server.port)
						? ("ready" as const)
						: failedForwards.has(server.port)
							? ("failed" as const)
							: ("pending" as const),
			publicationState:
				dependencies.publish === undefined || !eligible(server)
					? undefined
					: urls.has(server.port)
						? ("ready" as const)
						: failedPorts.has(server.port)
							? ("failed" as const)
							: ("pending" as const),
		}));
		if (
			next.length === snapshot.length &&
			next.every((server, index) => {
				const previous = snapshot[index];
				return (
					previous?.port === server.port &&
					previous.name === server.name &&
					previous.isWebServer === server.isWebServer &&
					previous.loopbackOnly === server.loopbackOnly &&
					previous.publicUrl === server.publicUrl &&
					previous.localUrl === server.localUrl &&
					previous.forwardingState === server.forwardingState &&
					previous.publicationState === server.publicationState
				);
			})
		)
			return;
		snapshot = next;
		for (const listener of listeners) listener();
	};
	const refresh = async (current: number): Promise<void> => {
		try {
			const servers = await dependencies.list();
			if (current !== generation) return;
			failures = 0;
			const ports = new Set(
				servers.filter(eligible).map((server) => server.port),
			);
			for (const port of localUrls.keys())
				if (!ports.has(port)) localUrls.delete(port);
			for (const port of failedForwards)
				if (!ports.has(port)) failedForwards.delete(port);
			for (const port of urls.keys()) if (!ports.has(port)) urls.delete(port);
			for (const port of failedPorts)
				if (!ports.has(port)) failedPorts.delete(port);
			update(servers);

			const publish = dependencies.publish;
			if (publish !== undefined || dependencies.forward !== undefined) {
				const pending = servers
					.filter(
						(server) =>
							eligible(server) &&
							(dependencies.forward !== undefined || !urls.has(server.port)),
					)
					.map((server) => server.port);
				await Promise.all(
					Array.from({ length: Math.min(4, pending.length) }, async () => {
						while (current === generation) {
							const port = pending.shift();
							if (port === undefined) return;
							if (publish !== undefined && !urls.has(port))
								try {
									const url = await publish(port);
									if (current === generation) {
										urls.set(port, url);
										failedPorts.delete(port);
										update(servers);
									}
								} catch {
									if (current === generation) {
										failedPorts.add(port);
										update(servers);
									}
								}
							if (
								current === generation &&
								dependencies.forward !== undefined
							) {
								try {
									const localPort = await dependencies.forward(port);
									if (current === generation) {
										localUrls.set(port, `http://localhost:${localPort}`);
										failedForwards.delete(port);
										update(servers);
									}
								} catch {
									if (current === generation) {
										localUrls.delete(port);
										failedForwards.add(port);
										update(servers);
									}
								}
							}
						}
					}),
				);
			}
			if (current !== generation) return;
			update(servers);
		} catch {
			if (current !== generation) return;
			failures += 1;
			urls.clear();
			localUrls.clear();
			failedForwards.clear();
			failedPorts.clear();
			update(EMPTY_PREVIEWS);
		} finally {
			if (current === generation && listeners.size > 0) {
				timer = setTimeout(
					() => void refresh(current),
					Math.min(30_000, 5_000 * 2 ** failures),
				);
			}
		}
	};
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			if (listeners.size === 1) void refresh(++generation);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					generation += 1;
					clearTimeout(timer);
					urls.clear();
					localUrls.clear();
					failedForwards.clear();
					failedPorts.clear();
					snapshot = EMPTY_PREVIEWS;
					failures = 0;
					dependencies.onIdle?.();
				}
			};
		},
	};
};
