import { ReviewGuideChapter } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	liveHunkIds,
	NEW_SINCE_GUIDE_ID,
	projectGuide,
} from "../../src/review-guide-view.ts";

const patch = (path: string, body: ReadonlyArray<string>) => ({
	path,
	patch: `${[`--- a/${path}`, `+++ b/${path}`, ...body].join("\n")}\n`,
});

const patches = [
	patch("src/api.ts", ["@@ -1 +1 @@", "-a", "+b"]),
	patch("src/store.ts", ["@@ -1 +1 @@", "-c", "+d", "@@ -9 +9 @@", "-e", "+f"]),
	patch("src/store.test.ts", ["@@ -1 +1 @@", "-t", "+u"]),
	{ path: "logo.png", patch: "" },
];
const [api, store1, store2, test, logo] = liveHunkIds(patches);

const chapter = (
	id: string,
	ordinal: number,
	hunkIds: ReadonlyArray<string | undefined>,
	kind: "core" | "tests" | "mechanical" = "core",
	validatedBy: ReadonlyArray<string | undefined> = [],
) =>
	new ReviewGuideChapter({
		id,
		ordinal,
		kind,
		title: id,
		summary: "",
		hunkIds: hunkIds as ReadonlyArray<string>,
		validatedBy: validatedBy as ReadonlyArray<string>,
		askHints: [],
		auto: kind !== "core",
	});

const labels = { newTitle: "New since guide", newSummary: "" };

describe("projectGuide", () => {
	it("orders files by chapter and collapses grouped files", () => {
		const view = projectGuide(
			[
				chapter("store", 0, [store1, store2], "core", [test]),
				chapter("api", 1, [api]),
				chapter("auto-tests", 2, [test], "tests"),
				chapter("auto-mechanical", 3, [logo], "mechanical"),
			],
			patches,
			labels,
		);
		expect(view.chapters.map((entry) => entry.files)).toEqual([
			["src/store.ts"],
			["src/api.ts"],
			["src/store.test.ts"],
			["logo.png"],
		]);
		expect(view.chapters.map((entry) => entry.number)).toEqual([
			1,
			2,
			null,
			null,
		]);
		expect(view.chapters[0]?.testFiles).toEqual(["src/store.test.ts"]);
		expect(view.chapters.some((entry) => entry.kind === "new")).toBe(false);
	});

	it("surfaces hunks written after the guide and marks changed chapters", () => {
		const view = projectGuide(
			[chapter("store", 0, [store1, "src/store.ts@gone"])],
			patches,
			labels,
		);
		expect(view.chapters[0]?.id).toBe(NEW_SINCE_GUIDE_ID);
		expect(view.chapters[0]?.files).toEqual([
			"src/api.ts",
			"src/store.ts",
			"src/store.test.ts",
			"logo.png",
		]);
		expect(view.chapters[1]?.changed).toBe(true);
		expect(view.chapters[0]?.hunkCount).toBe(4);
	});
});
