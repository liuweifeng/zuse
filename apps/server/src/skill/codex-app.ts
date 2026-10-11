import { CodexAppServerClient } from "@zuse/agents/drivers/codex-app-server-client";
import { Effect } from "effect";

/**
 * Short-lived `codex app-server` for one-shot config writes (e.g. the native
 * skill enabled flag) so Codex keeps owning its own config semantics.
 */
export const withCodexApp = <A>(
	codexPath: string | null,
	run: (app: CodexAppServerClient) => Promise<A>,
): Effect.Effect<A, Error> =>
	Effect.tryPromise({
		try: async () => {
			const app = await CodexAppServerClient.start({
				codexPath,
				startupTimeoutMs: 20_000,
				onNotification: () => undefined,
				// Nothing interactive runs in these one-shot calls; deny-by-noop
				// keeps a stray server request from wedging the child.
				onServerRequest: (_request, respond) => respond({}),
			});
			try {
				return await run(app);
			} finally {
				app.close();
			}
		},
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});
