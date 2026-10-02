import { Effect } from "effect";

/** Cleanup must run on cancellation but cannot hold the lifecycle indefinitely. */
export const closeProviderHandle = (handle: {
	readonly close: () => Effect.Effect<void>;
}) =>
	Effect.interruptible(handle.close()).pipe(
		Effect.timeout("5 seconds"),
		Effect.exit,
		Effect.asVoid,
	);
