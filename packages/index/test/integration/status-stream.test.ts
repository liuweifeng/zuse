import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
	IndexConfigTag,
	IndexService,
	IndexServiceLive,
	type IndexStatus,
} from "../../src/index.ts";

describe("IndexService.statusStream", () => {
	it("emits the indexing → ready sequence during a reindex", async () => {
		const root = mkdtempSync(join(tmpdir(), "mz-status-"));
		try {
			writeFileSync(
				join(root, "a.ts"),
				"export function alpha() { return 1; }\n",
			);
			writeFileSync(
				join(root, "b.ts"),
				"export const beta = (n: number) => n * 2;\n",
			);

			const layer = IndexServiceLive.pipe(
				Layer.provide(
					Layer.succeed(IndexConfigTag, {
						root,
						branch: "main",
						dbPath: ":memory:",
					}),
				),
			);
			const runtime = ManagedRuntime.make(layer);

			const collected: Array<IndexStatus["state"]> = [];

			const fiber = runtime.runFork(
				Effect.flatMap(IndexService, (svc) =>
					Stream.runForEach(svc.statusStream, (s) =>
						Effect.sync(() => {
							if (
								collected[collected.length - 1] !== s.state ||
								collected.length === 0
							) {
								collected.push(s.state);
							}
						}),
					),
				),
			);

			await new Promise((res) => setTimeout(res, 20));

			await runtime.runPromise(
				Effect.flatMap(IndexService, (svc) => svc.reindex()),
			);

			await new Promise((res) => setTimeout(res, 50));
			await runtime.runPromise(Fiber.interrupt(fiber));
			await runtime.dispose();

			expect(collected).toContain("indexing");
			expect(collected[collected.length - 1]).toBe("ready");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
