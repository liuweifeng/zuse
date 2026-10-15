import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_MODEL_CATALOG, ModelCatalog } from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

const publishedPath = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"web",
	"public",
	"models",
	"v1.json",
);

describe("published model catalog", () => {
	it("matches the bundled snapshot", () => {
		const raw = readFileSync(publishedPath, "utf8");
		const decoded = Schema.decodeUnknownSync(ModelCatalog)(JSON.parse(raw));
		expect(decoded.revision).toBe(BUNDLED_MODEL_CATALOG.revision);
		expect(JSON.parse(raw)).toEqual(
			Schema.encodeSync(ModelCatalog)(BUNDLED_MODEL_CATALOG),
		);
		expect(raw.endsWith("\n")).toBe(true);
	});
});
