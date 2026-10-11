import type {
	AttemptOwnershipConflict,
	CommandReceipt,
	DispatchInput,
	ProviderSessionOwnershipConflict,
} from "@zuse/domain/engine/dispatch";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect } from "effect";

/** Stale runtime work is expected; persistence failures must not be hidden. */
export const dispatchReservedRuntimeCommand = (
	domain: Pick<SessionDomainApi, "dispatch">,
	input: DispatchInput,
): Effect.Effect<
	CommandReceipt,
	AttemptOwnershipConflict | ProviderSessionOwnershipConflict
> =>
	domain
		.dispatch(input)
		.pipe(
			Effect.catch((error) =>
				error._tag === "AttemptOwnershipConflict" ||
				error._tag === "ProviderSessionOwnershipConflict"
					? Effect.fail(error)
					: Effect.die(error),
			),
		);
