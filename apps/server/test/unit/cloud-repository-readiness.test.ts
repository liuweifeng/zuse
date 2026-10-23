import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	watch: vi.fn(() => {
		throw Object.assign(
			new Error("System limit for number of file watchers reached"),
			{ code: "ENOSPC" },
		);
	}),
}));
const { waitForRepository } = await import(
	"../../src/api/cloud-workspace-runtime.ts"
);

test("an already prepared repository starts even when file watchers are exhausted", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-repository-ready-"));
	try {
		const marker = join(directory, "repository-ready");
		await writeFile(marker, "ready\n");
		await expect(
			Effect.runPromise(waitForRepository(() => {}, marker)),
		).resolves.toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.each([
	"repository-ready",
	"failed",
])("observes a later %s marker without filesystem watchers", async (result) => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-repository-ready-"));
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const pending = Effect.runPromise(
			waitForRepository(() => {}, join(directory, "repository-ready")),
		);
		const assertion =
			result === "failed"
				? expect(pending).rejects.toMatchObject({
						reason: "workspace_repository_ready_failed",
					})
				: expect(pending).resolves.toBeUndefined();
		timer = setTimeout(() => {
			void writeFile(join(directory, result), "ready\n");
		}, 30);
		await assertion;
	} finally {
		clearTimeout(timer);
		await rm(directory, { recursive: true, force: true });
	}
});

test("a failure marker takes precedence over a retained ready marker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-repository-ready-"));
	try {
		await writeFile(join(directory, "repository-ready"), "ready\n");
		await writeFile(join(directory, "failed"), "failed\n");
		await expect(
			Effect.runPromise(
				waitForRepository(() => {}, join(directory, "repository-ready")),
			),
		).rejects.toMatchObject({ reason: "workspace_repository_ready_failed" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("pending preparation reports progress and can be interrupted", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-repository-ready-"));
	const controller = new AbortController();
	const progress: string[] = [];
	try {
		await writeFile(
			join(directory, "repository-progress"),
			"fetching-repository\n",
		);
		const pending = Effect.runPromise(
			waitForRepository(
				(phase) => {
					progress.push(phase);
					controller.abort();
				},
				join(directory, "repository-ready"),
			),
			{ signal: controller.signal },
		);
		await expect(pending).rejects.toBeDefined();
		expect(progress).toEqual(["fetching-repository"]);
	} finally {
		controller.abort();
		await rm(directory, { recursive: true, force: true });
	}
});
