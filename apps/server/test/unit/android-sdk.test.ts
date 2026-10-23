import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installCmdlineTools } from "../../src/simulators/android-sdk.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

it.each([
	true,
	false,
])("checks chunked SDK downloads before installing (valid=%s)", async (valid) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-android-sdk-"));
	roots.push(root);
	const chunks = [Buffer.from("archive"), Buffer.from(" contents")];
	const archive = Buffer.concat(chunks);
	const progress = vi.fn();
	const unzip = vi.fn(async (zip: string, into: string) => {
		expect(await readFile(zip)).toEqual(archive);
		await mkdir(join(into, "cmdline-tools"));
		await writeFile(
			join(into, "cmdline-tools", "source.properties"),
			"installed",
		);
	});
	const download = installCmdlineTools({
		root,
		url: "https://example.com/tools.zip",
		sha1: valid ? createHash("sha1").update(archive).digest("hex") : "invalid",
		signal: new AbortController().signal,
		onProgress: progress,
		unzip,
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(chunk);
						controller.close();
					},
				}),
				{ headers: { "content-length": String(archive.length) } },
			),
	});
	if (valid) {
		await download;
		expect(unzip).toHaveBeenCalledOnce();
		expect(
			await readFile(
				join(root, "cmdline-tools", "latest", "source.properties"),
				"utf8",
			),
		).toBe("installed");
		expect(progress).toHaveBeenLastCalledWith(100);
	} else {
		await expect(download).rejects.toThrow("published checksum");
		expect(unzip).not.toHaveBeenCalled();
	}
	expect(
		(await readdir(root)).filter((name) => name.startsWith(".zuse-")),
	).toEqual([]);
});
