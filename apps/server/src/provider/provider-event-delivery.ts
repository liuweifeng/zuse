import type { ProviderSessionHandle } from "@zuse/agents/kernel/driver";
import type { ProviderEventEnvelope } from "@zuse/contracts";
import { Effect } from "effect";

/** Process-local delivery authority, captured from the emitting handle, never persisted. */
export interface ProviderCursorReceipt {
	readonly cursor: string;
	readonly acknowledge: Effect.Effect<void>;
	readonly release: Effect.Effect<void>;
}

export type ProviderEventDelivery = ProviderEventEnvelope & {
	readonly cursorReceipt?: ProviderCursorReceipt;
};

export const bindProviderEventDelivery = (
	handle: Pick<
		ProviderSessionHandle,
		"acknowledgeProviderEventCursor" | "releaseProviderEventCursor"
	>,
	envelope: ProviderEventEnvelope,
): ProviderEventDelivery => {
	const event = envelope.event;
	const cursor =
		event._tag === "ProviderNotificationMetadata"
			? event.eventId
			: event._tag === "SessionCursor"
				? event.providerEventCursor
				: undefined;
	if (cursor === undefined) return envelope;
	return {
		...envelope,
		cursorReceipt: {
			cursor,
			acknowledge: Effect.suspend(
				() => handle.acknowledgeProviderEventCursor?.(cursor) ?? Effect.void,
			),
			release: Effect.suspend(
				() => handle.releaseProviderEventCursor?.(cursor) ?? Effect.void,
			),
		},
	};
};
