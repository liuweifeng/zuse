import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("missing Bun exits with an actionable startup error", () => {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/dev.mjs", "--instance", "missing-bun-test"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: { ...process.env, PATH: "", Path: "" },
			encoding: "utf8",
			timeout: 15_000,
		},
	);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /failed to start.*bun/);
	assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});
