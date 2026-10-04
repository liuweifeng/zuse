import { Schema } from "effect";
import { expect, it } from "vitest";
import {
	BUILTIN_PROVIDER_CHOICES,
	ProviderAvailabilityRpc,
	ProviderId,
} from "../../src/agent.ts";
import { BUNDLED_MODEL_CATALOG } from "../../src/model-catalog/bundled.ts";
import {
	catalogProviderIds,
	selectableCatalogProviderIds,
} from "../../src/model-catalog/helpers.ts";

it("keeps legacy Gemini histories readable while offering it through ACP for new setup", () => {
	expect(Schema.decodeUnknownSync(ProviderId)("gemini")).toBe("gemini");
	expect(catalogProviderIds(BUNDLED_MODEL_CATALOG)).toContain("gemini");
	expect(BUILTIN_PROVIDER_CHOICES).not.toContain("gemini");
	expect(selectableCatalogProviderIds(BUNDLED_MODEL_CATALOG)).not.toContain(
		"gemini",
	);
	const catalog = {
		...BUNDLED_MODEL_CATALOG,
		providers: {
			...BUNDLED_MODEL_CATALOG.providers,
			"acp-gemini": { models: [], aliases: {} },
		},
	};
	expect(selectableCatalogProviderIds(catalog)).toContain("acp-gemini");
});

it("accepts an inventory containing custom ACP agents without rejecting built-in providers", () => {
	const inventory = [
		{
			providerId: "codex",
			displayName: "Codex",
			cliInstalled: true,
			cliLoggedIn: true,
			hasApiKey: false,
		},
		{
			providerId: "acp-ce3854c9-9cd0-49f7-9cf1-00d6cfb2794c",
			displayName: "Custom ACP",
			cliInstalled: true,
			cliLoggedIn: false,
			hasApiKey: false,
		},
	];
	const decoded = Schema.decodeUnknownSync(
		ProviderAvailabilityRpc.successSchema,
	)(inventory);
	expect(decoded).toEqual(inventory);
	expect(
		decoded.find((provider) => provider.providerId === "codex")?.cliLoggedIn,
	).toBe(true);
});
