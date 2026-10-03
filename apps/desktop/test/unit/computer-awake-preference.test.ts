import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	readComputerAwakePreference,
	watchComputerAwakePreference,
	writeComputerAwakePreference,
} from "../../src/computer-awake-preference.ts";

describe("computer awake preference", () => {
	it("defaults missing and malformed preferences to auto", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-awake-pref-"));
		await expect(readComputerAwakePreference(directory)).resolves.toBe("auto");

		await writeFile(join(directory, "computer-awake.json"), "not json", "utf8");
		await expect(readComputerAwakePreference(directory)).resolves.toBe("auto");

		await writeFile(
			join(directory, "computer-awake.json"),
			JSON.stringify({ mode: "timed" }),
			"utf8",
		);
		await expect(readComputerAwakePreference(directory)).resolves.toBe("auto");
	});

	it("persists a validated host mode atomically", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-awake-pref-"));
		await writeComputerAwakePreference(directory, "always");

		await expect(readComputerAwakePreference(directory)).resolves.toBe(
			"always",
		);
		await expect(
			readFile(join(directory, "computer-awake.json"), "utf8"),
		).resolves.toContain('"mode": "always"');
		await expect(readdir(directory)).resolves.toEqual(["computer-awake.json"]);
	});
});

it("the engine observes atomic preference replacements without a desktop connection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-awake-watch-"));
	const modes: string[] = [];
	const stop = watchComputerAwakePreference(directory, (mode) => {
		modes.push(mode);
	});
	try {
		await expect.poll(() => modes.at(-1)).toBe("auto");
		await writeComputerAwakePreference(directory, "off");
		await expect.poll(() => modes.at(-1), { timeout: 4000 }).toBe("off");
		await writeComputerAwakePreference(directory, "always");
		await expect.poll(() => modes.at(-1), { timeout: 4000 }).toBe("always");
	} finally {
		stop();
		await rm(directory, { recursive: true, force: true });
	}
}, 10_000);
