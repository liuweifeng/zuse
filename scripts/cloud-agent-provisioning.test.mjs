import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Boat installs Grok without replacing provider-owned Claude or Codex", () => {
	const installer = readFileSync(
		new URL("../infra/cloud-sandboxes/box/install.sh", import.meta.url),
		"utf8",
	);
	const stages = installer.match(
		/"\$provision_dir\/provision.sh" ([\w -]+)/,
	)?.[1];
	assert.ok(stages);
	const provision = readFileSync(
		new URL("../infra/cloud-sandboxes/provision.sh", import.meta.url),
		"utf8",
	);

	const dispatch = provision.indexOf('for stage in "$@"; do');
	assert.ok(dispatch > 0);
	const result = spawnSync(
		"bash",
		[
			"-c",
			`${provision.slice(0, dispatch)}
stage_packages() { :; }
stage_runtime_tools() { :; }
stage_runtime() { :; }
stage_layout() { :; }
stage_globals() { echo replaced-provider-agents; }
stage_grok() { echo installed-grok; }
${provision.slice(dispatch)}`,
			"provision-test",
			...stages.split(" "),
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /installed-grok/);
	assert.doesNotMatch(result.stdout, /replaced-provider-agents/);
});
