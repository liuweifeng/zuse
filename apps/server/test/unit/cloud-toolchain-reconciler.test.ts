import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("reconciles an installed image toolchain into user-owned command links", () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-toolchain-"));
	try {
		const manifest = {
			schemaVersion: 1,
			architecture: "linux-x64",
			version: "2026.10.11.1",
			systemPackages: [],
			npmPackages: {
				bun: "1.0.0",
				corepack: "1.0.0",
				"@anthropic-ai/claude-code": "1.0.0",
				"@openai/codex": "1.0.0",
			},
		};
		const release = join(root, "releases", manifest.version);
		const tools = join(release, "node_modules/.bin");
		const system = join(root, "system");
		const links = join(root, "user-bin");
		mkdirSync(tools, { recursive: true });
		mkdirSync(system);
		const manifestPath = join(root, "manifest.json");
		writeFileSync(manifestPath, JSON.stringify(manifest));
		writeFileSync(
			join(release, "zuse-toolchain.json"),
			JSON.stringify(manifest),
		);
		for (const name of ["bun", "corepack", "claude", "codex"])
			writeFileSync(join(tools, name), "#!/bin/sh\necho 1.0.0\n", {
				mode: 0o755,
			});
		for (const name of [
			"git",
			"gh",
			"git-lfs",
			"ssh",
			"tmux",
			"rg",
			"fd",
			"jq",
			"python3",
		])
			writeFileSync(join(system, name), "#!/bin/sh\necho fixture-version\n", {
				mode: 0o755,
			});
		const current = join(root, "current");
		const run = () =>
			spawnSync(
				process.execPath,
				[resolve("apps/server/scripts/toolchain-reconciler.mjs"), manifestPath],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: system,
						ZUSE_TOOLCHAINS_ROOT: join(root, "releases"),
						ZUSE_TOOLCHAIN_CURRENT_LINK: current,
						ZUSE_TOOLCHAIN_BIN_DIR: links,
						ZUSE_TOOLCHAIN_SKIP_SYSTEM_PACKAGES: "1",
						ZUSE_TOOLCHAIN_SKIP_INSTALL: "1",
						ZUSE_RUNTIME_SKIP_TRIGGER_INSTALL: "1",
					},
				},
			);
		const first = run();
		expect(first.status, first.stderr).toBe(0);
		expect(readlinkSync(current)).toBe(release);
		for (const name of ["bun", "corepack", "claude", "codex"])
			expect(readlinkSync(join(links, name))).toBe(
				join(current, "node_modules/.bin", name),
			);
		const repeated = run();
		expect(repeated.status, repeated.stderr).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
