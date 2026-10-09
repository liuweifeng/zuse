import { bundledResolvedModelCatalog } from "@zuse/contracts";
import { expect, it } from "vitest";
import { buildOrchestrationModelInventory } from "../../src/conversation/core/orchestration-discovery.ts";

it("discovers registered ACP providers from the resolved catalog", () => {
	const catalog = bundledResolvedModelCatalog();
	const providerId = "acp-custom-agent";
	const result = buildOrchestrationModelInventory(
		{
			...catalog,
			providers: {
				...catalog.providers,
				[providerId]: {
					...catalog.providers.codex,
					displayName: "Custom agent",
				},
			},
		},
		null,
		providerId,
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.providers).toHaveLength(1);
	expect(result.providers[0]).toMatchObject({
		providerId,
		enabled: true,
		appTools: true,
		planMode: false,
	});
	expect(result.providers[0]?.models.length).toBeGreaterThan(0);
});

it("does not invent providers absent from the current runtime catalog", () => {
	expect(
		buildOrchestrationModelInventory(
			bundledResolvedModelCatalog(),
			null,
			"acp-missing",
		),
	).toEqual({ ok: false, error: "Unknown providerId: acp-missing" });
});
