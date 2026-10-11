import type { ProviderHandleUnavailable } from "@zuse/agents/kernel/turn-protocol";
import {
	type AgentSessionId,
	AgentSessionNotFoundError,
	type ProviderAttemptOwnership,
} from "@zuse/contracts";
import { Effect } from "effect";
import { closeProviderHandle } from "./provider-handle-cleanup.ts";
import type { ProviderSessionRegistry } from "./provider-session-registry.ts";

/** Admission is repeated after asynchronous preparation, before invoking the handle. */
export const sendProviderSession = <
	Entry extends {
		readonly providerSessionId: string;
		readonly ownership?: ProviderAttemptOwnership;
		readonly handle: { readonly close: () => Effect.Effect<void> };
	},
>(input: {
	readonly registry: ProviderSessionRegistry<AgentSessionId, Entry>;
	readonly sessionId: AgentSessionId;
	readonly entry: Entry;
	readonly ownership?: ProviderAttemptOwnership;
	readonly prepare: Effect.Effect<void>;
	readonly send: () => Effect.Effect<void, ProviderHandleUnavailable>;
}) =>
	Effect.suspend(() => {
		const current = () =>
			input.registry.lookup(input.sessionId) === input.entry &&
			input.registry.currentProviderSessionId(input.sessionId) ===
				input.entry.providerSessionId &&
			(input.ownership === undefined ||
				(input.entry.ownership?.turnId === input.ownership.turnId &&
					input.entry.ownership.attemptId === input.ownership.attemptId));
		const unavailable = () =>
			new AgentSessionNotFoundError({ sessionId: input.sessionId });
		let retired = false;
		const retire = Effect.suspend(() => {
			if (retired) return Effect.void;
			retired = true;
			if (current()) input.registry.invalidate(input.sessionId);
			return closeProviderHandle(input.entry.handle);
		});
		if (!current()) return Effect.fail(unavailable());
		return input.prepare.pipe(
			Effect.andThen(
				Effect.suspend(() => {
					if (!current()) return Effect.fail(unavailable());
					return input
						.send()
						.pipe(
							Effect.catchTag("ProviderHandleUnavailable", () =>
								retire.pipe(Effect.andThen(Effect.fail(unavailable()))),
							),
						);
				}),
			),
			Effect.onInterrupt(() => retire),
		);
	});
