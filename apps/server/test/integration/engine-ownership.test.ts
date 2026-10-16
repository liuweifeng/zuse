import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { SqliteLive } from "../../src/persistence/sqlite.ts";

const openRuntime = (userData: string) =>
	ManagedRuntime.make(
		SqliteLive.pipe(Layer.provide(Layer.succeed(AppPaths, { userData }))),
	);
const readDatabase = Effect.flatMap(
	SqlClient.SqlClient,
	(sql) => sql`SELECT 1 AS ready`,
);

describe("engine ownership", () => {
	test("prevents a second runtime from opening persistence until the owner closes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "engine-owner-"));
		const first = openRuntime(directory);
		const second = openRuntime(directory);
		try {
			expect(await first.runPromise(readDatabase)).toEqual([{ ready: 1 }]);
			await expect(second.runPromise(readDatabase)).rejects.toMatchObject({
				_tag: "EngineOwnershipError",
				dataDirectory: directory,
			});

			await second.dispose();
			const third = openRuntime(directory);
			try {
				await expect(third.runPromise(readDatabase)).rejects.toMatchObject({
					_tag: "EngineOwnershipError",
				});
			} finally {
				await third.dispose();
			}
			await first.dispose();
			const replacement = openRuntime(directory);
			try {
				expect(await replacement.runPromise(readDatabase)).toEqual([
					{ ready: 1 },
				]);
			} finally {
				await replacement.dispose();
			}
		} finally {
			await second.dispose();
			await first.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
