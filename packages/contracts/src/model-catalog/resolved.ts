import { Schema } from "effect";

import { ModelOption, OpencodeInventory, ProviderId } from "../agent.ts";
import { ModelPricing } from "./schema.ts";

/**
 * Facts a live provider inventory reports about a model that the curated
 * catalog doesn't carry. Drivers use reasoning/tier capabilities and native harness context limits;
 * other fields provide presentation metadata.
 */
export const ModelLiveMeta = Schema.Struct({
	contextWindowTokens: Schema.optional(Schema.Number),
	autoCompactTokenLimit: Schema.optional(Schema.Number),
	effectiveContextWindowPercent: Schema.optional(Schema.Number),
	rateMultiplier: Schema.optional(Schema.Number),

	variants: Schema.optional(Schema.Array(Schema.String)),

	reasoningEfforts: Schema.optional(Schema.Array(Schema.String)),

	fastTier: Schema.optional(Schema.Boolean),
	description: Schema.optional(Schema.String),
});
export type ModelLiveMeta = typeof ModelLiveMeta.Type;

export const ModelOrigin = Schema.Literals(["curated", "live", "both"]);
export type ModelOrigin = typeof ModelOrigin.Type;

/**
 * A curated entry merged with what the provider actually reports.
 *   - `origin`    — where the entry came from.
 *   - `available` — `false` when an authoritative live list omits a curated
 *     model (account tier, region, retired upstream). Pickers hide these
 *     unless currently selected; drivers still accept them.
 */
export const ResolvedModelOption = Schema.Struct({
	...ModelOption.fields,
	origin: ModelOrigin,
	available: Schema.Boolean,
	liveMeta: Schema.optional(ModelLiveMeta),
});
export type ResolvedModelOption = typeof ResolvedModelOption.Type;

export const LiveListingState = Schema.Literals([
	"unsupported",
	"pending",
	"ok",
	"error",
]);
export type LiveListingState = typeof LiveListingState.Type;

export const LiveListingStatus = Schema.Struct({
	status: LiveListingState,

	authoritative: Schema.Boolean,
	fetchedAt: Schema.NullOr(Schema.Number),
	error: Schema.NullOr(Schema.String),
});
export type LiveListingStatus = typeof LiveListingStatus.Type;

export const ResolvedModelCatalogProvider = Schema.Struct({
	displayName: Schema.optional(Schema.String),
	icon: Schema.optional(Schema.String),
	commands: Schema.optional(
		Schema.Array(
			Schema.Struct({ name: Schema.String, description: Schema.String }),
		),
	),
	models: Schema.Array(ResolvedModelOption),
	aliases: Schema.Record(Schema.String, Schema.String),
	defaultModelId: Schema.String,
	live: LiveListingStatus,

	opencode: Schema.optional(OpencodeInventory),
	opencode2: Schema.optional(OpencodeInventory),
});
export type ResolvedModelCatalogProvider =
	typeof ResolvedModelCatalogProvider.Type;

export const ResolvedCatalogSource = Schema.Literals([
	"bundled",
	"cached",
	"remote",
]);
export type ResolvedCatalogSource = typeof ResolvedCatalogSource.Type;

/**
 * What the `model.catalog` RPC returns: the curated catalog (bundled, disk
 * cached, or freshly fetched — whichever has the highest revision) merged
 * with every provider's live inventory. Always complete: every `ProviderId`
 * has an entry.
 */
export const ResolvedModelCatalog = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	revision: Schema.Number,
	generatedAt: Schema.String,
	source: ResolvedCatalogSource,
	fetchedAt: Schema.NullOr(Schema.Number),
	providers: Schema.Record(ProviderId, ResolvedModelCatalogProvider),
	pricing: Schema.Record(Schema.String, ModelPricing),
});
export type ResolvedModelCatalog = typeof ResolvedModelCatalog.Type;
