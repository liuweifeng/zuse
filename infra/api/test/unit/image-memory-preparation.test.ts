import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { IMAGE_MEMORY_PREPARATION_SCRIPT } from "../../src/image-memory-preparation.ts";

test("missing optional agent cache paths do not fail image preparation", () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-image-warmup-"));
	try {
		mkdirSync(join(root, "current"));
		mkdirSync(join(root, "node-compile-cache"));
		writeFileSync(join(root, "current/bin.mjs"), "// runtime");

		const warmup = IMAGE_MEMORY_PREPARATION_SCRIPT.split(
			"ZUSE_IMAGE_MEMORY\n",
		)[1];
		if (!warmup) throw new Error("missing image warm-up");
		expect(() =>
			execFileSync("bash", ["-ec", warmup.replaceAll("/opt/zuse", root)], {
				stdio: "pipe",
			}),
		).not.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
