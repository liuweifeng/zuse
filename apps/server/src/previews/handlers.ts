import {
	DEFAULT_LOCAL_DESKTOP_PORT,
	MemoizeRpcs,
	PreviewServer,
	PreviewsError,
} from "@zuse/contracts";
import {
	isHttpPreview,
	listListeningServers,
} from "@zuse/utils/port-inspector";
import { Effect, Layer } from "effect";

const PreviewsListServers = MemoizeRpcs.toLayerHandler(
	"previews.listServers",
	() =>
		Effect.tryPromise({
			try: async () => {
				const servers = (
					await listListeningServers(process.platform, process.pid)
				).filter((server) => server.port !== DEFAULT_LOCAL_DESKTOP_PORT);
				const verified = new Map<number, boolean>();
				const queue = [...servers];
				await Promise.all(
					Array.from({ length: Math.min(4, queue.length) }, async () => {
						for (let server = queue.shift(); server; server = queue.shift()) {
							verified.set(
								server.port,
								(await isHttpPreview(server.port)) ||
									(await isHttpPreview(server.port, "::1")),
							);
						}
					}),
				);
				return servers.map((server) => ({
					...server,
					isWebServer: verified.get(server.port) === true,
				}));
			},
			catch: (cause) =>
				new PreviewsError({
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		}).pipe(
			Effect.map((servers) => ({
				servers: servers
					.filter((server) => server.port !== DEFAULT_LOCAL_DESKTOP_PORT)
					.slice(0, 50)
					.map(
						(server) =>
							new PreviewServer({
								name: server.name,
								isWebServer: server.isWebServer,
								port: server.port,
								loopbackOnly: server.loopbackOnly,
							}),
					),
			})),
		),
);

export const PreviewsHandlersLayer = Layer.mergeAll(PreviewsListServers);
