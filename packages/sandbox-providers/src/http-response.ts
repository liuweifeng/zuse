import { Effect } from "effect";

/** Release the connection when only the HTTP status is needed. */
export const discardResponseBody = (response: Response): Effect.Effect<void> =>
	Effect.tryPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
		Effect.ignore,
	);
