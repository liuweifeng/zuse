import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProviderRef } from "../../src/index.ts";

describe("provider references", () => {
	it("preserves custom ACP identity and native correlation evidence", () => {
		const reference = {
			provider: "acp-custom",
			nativeId: "thread-1",
			strength: "weak",
			fingerprint: "fingerprint",
			ordinal: 0,
		};
		expect(
			Schema.encodeSync(ProviderRef)(
				Schema.decodeUnknownSync(ProviderRef)(reference),
			),
		).toEqual(reference);
	});
	it("rejects invalid native correlation ordinals", () => {
		for (const ordinal of [-1, 0.5]) {
			expect(() =>
				Schema.decodeUnknownSync(ProviderRef)({
					provider: "codex",
					nativeId: null,
					strength: "none",
					ordinal,
				}),
			).toThrow();
		}
	});
});
