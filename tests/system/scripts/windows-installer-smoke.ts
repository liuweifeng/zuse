import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.platform, "win32");
const installer = process.argv[2];
if (!installer) throw new Error("Expected a Windows NSIS installer path");
const root = await mkdtemp(join(tmpdir(), "zuse installer ü-"));
const install = join(root, "Zuse App");
const executable = join(install, "Zuse.exe");
const uninstaller = join(install, "Uninstall Zuse (Beta).exe");
const userData = join(root, "profile");
const run = (file: string, args: string[], verbatim = false) => {
	const result = spawnSync(file, args, {
		stdio: "inherit",
		timeout: 600_000,
		windowsVerbatimArguments: verbatim,
		env: { ...process.env, ZUSE_SMOKE_USER_DATA_DIR: userData },
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${file} exited with ${result.status}`);
};
try {
	// NSIS requires /D to be the last argument and consumes the remaining text,
	// including spaces. It must not receive Node's additional argument quotes.
	run(resolve(installer), ["/S", `/D=${install}`], true);
	assert.ok(existsSync(executable), "Installer did not produce Zuse.exe");
	assert.ok(
		existsSync(uninstaller),
		"Installer did not produce an uninstaller",
	);
	run(process.execPath, [
		"--import",
		"tsx",
		"tests/system/scripts/packaged-desktop-smoke.ts",
		executable,
	]);

	// Reinstallation must succeed with the existing installation registered.
	run(resolve(installer), ["/S", `/D=${install}`], true);
	assert.ok(existsSync(executable));
	execFileSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"tests/system/scripts/packaged-desktop-smoke.ts",
			executable,
		],
		{
			stdio: "inherit",
			timeout: 600_000,
			env: {
				...process.env,
				ZUSE_SMOKE_USER_DATA_DIR: userData,
				ZUSE_SMOKE_EXISTING_PROFILE: "1",
				ZUSE_SMOKE_REPORT_DIR: ".context/windows/reinstalled",
			},
		},
	);
	const registration = execFileSync(
		"reg.exe",
		["query", "HKCU\\Software\\Classes\\zuse\\shell\\open\\command", "/ve"],
		{ encoding: "utf8" },
	);
	assert.ok(
		registration.toLowerCase().includes(executable.toLowerCase()),
		"zuse:// must target the installed executable",
	);
} finally {
	if (existsSync(uninstaller)) run(uninstaller, ["/S", `_?=${install}`], true);
	assert.equal(
		existsSync(executable),
		false,
		"Uninstaller left the application executable behind",
	);
	if (existsSync(join(userData, "update-channel.json"))) {
		assert.equal(
			JSON.parse(await readFile(join(userData, "update-channel.json"), "utf8"))
				.channel,
			"preview",
		);
	}
	await rm(root, { recursive: true, force: true });
}
