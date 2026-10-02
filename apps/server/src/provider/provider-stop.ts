import type { ProviderAttemptOwnership } from "@zuse/contracts";
import { Effect } from "effect";
import { closeProviderHandle } from "./provider-handle-cleanup.ts";
import type { ProviderSessionRegistry } from "./provider-session-registry.ts";

/** Called under lifecycle serialization. Scoped stops never invalidate an unrelated pending startup. */
export const retireProviderSession = <
	Id,
	Entry extends {
		readonly providerSessionId?: string;
		readonly ownership?: ProviderAttemptOwnership;
	},
>(
	registry: ProviderSessionRegistry<Id, Entry>,
	sessionId: Id,
	ownership?: ProviderAttemptOwnership,
	expectedProviderSessionId?: string | null,
):
	| { readonly _tag: "obsolete" }
	| { readonly _tag: "retired"; readonly entry: Entry | undefined } => {
	const current = registry.lookup(sessionId);
	const currentProviderSessionId =
		current?.providerSessionId ?? registry.currentProviderSessionId(sessionId);
	if (
		expectedProviderSessionId !== undefined &&
		((current === undefined && currentProviderSessionId === undefined) ||
			(currentProviderSessionId ?? null) !== expectedProviderSessionId)
	)
		return { _tag: "obsolete" };
	if (
		ownership !== undefined &&
		(current?.ownership?.attemptId !== ownership.attemptId ||
			current.ownership.turnId !== ownership.turnId)
	)
		return { _tag: "obsolete" };
	return { _tag: "retired", entry: registry.invalidate(sessionId) };
};

/** Retiring a handle transfers cleanup ownership even if question detachment is interrupted. */
export const stopProviderSession = <
	Id,
	Entry extends {
		readonly providerSessionId?: string;
		readonly ownership?: ProviderAttemptOwnership;
		readonly handle: { readonly close: () => Effect.Effect<void> };
	},
>(input: {
	readonly registry: ProviderSessionRegistry<Id, Entry>;
	readonly sessionId: Id;
	readonly detachQuestions: Effect.Effect<void>;
	readonly ownership?: ProviderAttemptOwnership;
	readonly expectedProviderSessionId?: string | null;
}) =>
	Effect.acquireUseRelease(
		Effect.sync(() =>
			retireProviderSession(
				input.registry,
				input.sessionId,
				input.ownership,
				input.expectedProviderSessionId,
			),
		),
		(retired) =>
			(retired._tag === "obsolete" ? Effect.void : input.detachQuestions).pipe(
				Effect.as(retired),
			),
		(retired) =>
			retired._tag === "retired" && retired.entry !== undefined
				? closeProviderHandle(retired.entry.handle)
				: Effect.void,
	);
