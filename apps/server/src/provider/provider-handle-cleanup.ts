import { Effect } from "effect";
import type { ProviderSessionRegistry } from "./provider-session-registry.ts";

/** The provider layer owns published handles even after their turns have settled. */
export const ownProviderRegistry = <
	Id,
	Entry extends {
		readonly handle: { readonly close: () => Effect.Effect<void> };
	},
>(
	registry: ProviderSessionRegistry<Id, Entry>,
) =>
	Effect.addFinalizer(() =>
		Effect.suspend(() =>
			Effect.forEach(
				registry.close(),
				(entry) => closeProviderHandle(entry.handle),
				{ concurrency: "unbounded", discard: true },
			),
		),
	);

/** Cleanup must run on cancellation but cannot hold the lifecycle indefinitely. */
export const closeProviderHandle = (handle: {
	readonly close: () => Effect.Effect<void>;
}) =>
	Effect.interruptible(handle.close()).pipe(
		Effect.timeout("5 seconds"),
		Effect.exit,
		Effect.asVoid,
	);
