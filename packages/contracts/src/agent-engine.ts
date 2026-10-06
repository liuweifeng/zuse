import { Schema } from "effect";

import { ProviderId } from "./agent.ts";

/** Shared values persisted by session events and exposed by session snapshots. */
const NonNegativeInt = Schema.Number.check(
	Schema.isInt(),
	Schema.makeFilter((value) =>
		value >= 0 ? undefined : "Expected a non-negative integer.",
	),
);

export const NativeRefStrength = Schema.Literals(["strong", "weak", "none"]);
export type NativeRefStrength = typeof NativeRefStrength.Type;

export const ProviderRef = Schema.Struct({
	provider: ProviderId,
	nativeId: Schema.NullOr(Schema.String),
	strength: NativeRefStrength,
	fingerprint: Schema.optional(Schema.String),
	ordinal: Schema.optional(NonNegativeInt),
});
export type ProviderRef = typeof ProviderRef.Type;

export const TurnStatus = Schema.Literals([
	"preparing",
	"queued",
	"starting",
	"running",
	"finalizing",
	"completed",
	"interrupted",
	"failed",
	"cancelled",
	"rolled_back",
]);
export type TurnStatus = typeof TurnStatus.Type;

export const AttemptReason = Schema.Literals([
	"initial",
	"steering_restart",
	"retry",
	"provider_recovery",
]);
export type AttemptReason = typeof AttemptReason.Type;

export const ProviderThreadStatus = Schema.Literals([
	"not_loaded",
	"idle",
	"active",
	"archived",
	"closed",
	"error",
]);
export type ProviderThreadStatus = typeof ProviderThreadStatus.Type;
