import type { SessionId } from "@zuse/contracts";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect } from "effect";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";

/** A closed process and its canonical residency must agree before final capture. */
export const quiesceAndDetachProvider = (
	domain: SessionDomainApi,
	provider: Pick<ProviderServiceShape, "quiesce">,
	sessionId: SessionId,
) =>
	Effect.gen(function* () {
		if (provider.quiesce === undefined) return;
		const expectedProviderSessionId = yield* domain
			.providerReservation(sessionId)
			.pipe(Effect.orDie);
		yield* provider.quiesce(sessionId, expectedProviderSessionId);
		// Each retry checks current residency afresh. A distinct command receipt avoids
		// changing a previous receipt's timestamp; exact ownership makes repeats harmless.
		yield* domain
			.dispatch({
				streamId: sessionId,
				commandId: `provider-quiesced:${crypto.randomUUID()}`,
				command: {
					_tag: "DetachProvider",
					expectedProviderSessionId,
					detachedAt: Date.now(),
				},
			})
			.pipe(Effect.orDie);
	});
