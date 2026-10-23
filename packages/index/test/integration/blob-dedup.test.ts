import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { countAll } from "../../src/blob/store.ts";
import { closeIndexDb, openIndexDb } from "../../src/db/sqlite.ts";
import { indexRepo } from "../../src/indexer.ts";
import { runMigrations } from "../../src/schema/migrations.ts";

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(eff as Effect.Effect<A, E, never>);

const setupRepo = (files: Record<string, string>): string => {
	const root = mkdtempSync(join(tmpdir(), "mz-index-"));
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
	return root;
};

describe("indexer — blob dedup across branches", () => {
	it("two branches sharing identical files produce exactly one blob per file", async () => {
		const root = setupRepo({
			"a.ts": "export function a() { return 1; }\n",
			"b.ts": "export function b() { return 2; }\n",
		});
		try {
			const db = await run(openIndexDb(":memory:"));
			await run(runMigrations(db));

			const first = await run(indexRepo(db, root, "main"));
			expect(first.newBlobs).toBeGreaterThanOrEqual(2);

			const second = await run(indexRepo(db, root, "feature/x"));

			expect(second.newBlobs).toBe(0);
			expect(second.dedupedBlobs).toBe(second.processed);

			const stats = await run(countAll(db));

			expect(stats.blobs).toBe(first.processed);

			await run(closeIndexDb(db));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("changing one file on a new branch adds exactly one new blob", async () => {
		const root = setupRepo({
			"shared.ts": "export const shared = 'v1';\n",
			"stable.ts": "export const stable = 'forever';\n",
		});
		try {
			const db = await run(openIndexDb(":memory:"));
			await run(runMigrations(db));

			const first = await run(indexRepo(db, root, "main"));
			const blobsAfterFirst = (await run(countAll(db))).blobs;
			expect(first.newBlobs).toBe(first.processed);

			writeFileSync(join(root, "shared.ts"), "export const shared = 'v2';\n");
			const second = await run(indexRepo(db, root, "feature/y"));

			const blobsAfterSecond = (await run(countAll(db))).blobs;
			expect(blobsAfterSecond - blobsAfterFirst).toBe(1);
			expect(second.newBlobs).toBe(1);

			await run(closeIndexDb(db));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
