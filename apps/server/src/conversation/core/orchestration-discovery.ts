import type { OrchestrationProviderSummary } from "@zuse/agents/drivers/orchestration-discovery";
import {
	defaultModelFor,
	type ProviderId,
	providerCapabilities,
	type ResolvedModelCatalog,
	type SettingsFile,
	visibleModelsForProvider,
} from "@zuse/contracts";

/** Use the resolved catalog, which includes registered ACP agents, not a built-in ID list. */
export const buildOrchestrationModelInventory = (
	catalog: ResolvedModelCatalog,
	settings: SettingsFile | null,
	requestedProviderId?: string,
):
	| {
			readonly ok: true;
			readonly providers: ReadonlyArray<OrchestrationProviderSummary>;
	  }
	| { readonly ok: false; readonly error: string } => {
	const ids = Object.keys(catalog.providers) as ProviderId[];
	if (
		requestedProviderId !== undefined &&
		!ids.includes(requestedProviderId as ProviderId)
	) {
		return { ok: false, error: `Unknown providerId: ${requestedProviderId}` };
	}
	const selected =
		requestedProviderId === undefined
			? ids
			: [requestedProviderId as ProviderId];
	return {
		ok: true,
		providers: selected.map((providerId) => {
			const defaultModel =
				settings?.defaultModelByProvider?.[providerId] ??
				defaultModelFor(catalog, providerId);
			const models = visibleModelsForProvider(
				catalog,
				providerId,
				settings?.modelEnabledByProvider,
				{ includeModelId: defaultModel },
			).map((model) => ({
				id: model.id,
				label: model.label,
				defaultModel: model.id === defaultModel,
				available: model.available,
				reasoningEfforts: model.liveMeta?.reasoningEfforts,
				variants: model.liveMeta?.variants,
			}));
			const seen = new Set(models.map((model) => model.id));
			for (const id of settings?.customModelIdsByProvider?.[providerId] ?? []) {
				if (
					seen.has(id) ||
					settings?.modelEnabledByProvider?.[providerId]?.[id] === false
				)
					continue;
				models.push({
					id,
					label: id,
					defaultModel: id === defaultModel,
					available: true,
					reasoningEfforts: undefined,
					variants: undefined,
				});
				seen.add(id);
			}
			const traits = providerCapabilities(providerId);
			return {
				providerId,
				defaultModel,
				models,
				enabled:
					settings?.providerEnabled?.[providerId] ?? traits.enabledByDefault,
				appTools: traits.appTools,
				planMode: traits.planMode,
				inventoryStatus:
					catalog.providers[providerId]?.live.status ?? "unsupported",
			};
		}),
	};
};
