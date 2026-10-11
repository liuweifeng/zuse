import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PluginResponse } from "../../src/plugins.ts";

describe("plugin response", () => {
	it("decodes a catalog from an API that predates display metadata", () => {
		const snapshot = Schema.decodeUnknownSync(PluginResponse)({
			kind: "snapshot",
			tenants: [],
			tenantId: "personal:a",
			endpoint: "",
			connections: [],
			catalog: [
				{ id: "linear", name: "Linear", description: "Issues", auth: "oauth" },
			],
		});
		expect(snapshot.kind === "snapshot" && snapshot.catalog).toEqual([
			{
				id: "linear",
				name: "Linear",
				description: "Issues",
				domain: "",
				category: null,
				featured: false,
				custom: false,
				url: null,
				apiKeyHeader: null,
			},
		]);
	});
});
