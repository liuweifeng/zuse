import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { ApiStore, ApiStoreMemory } from "../../src/store.ts";

describe("Master dispatch ownership", () => {
	it("fences concurrent home transfers and keeps repository ownership exclusive", async () => {
		const runtime = ManagedRuntime.make(ApiStoreMemory);
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const store = yield* ApiStore;
					const first = {
						masterId: "master",
						homeEnvironmentId: "local",
						generation: 1,
						repositories: [
							{ environmentId: "cloud", folderId: "repository", name: "Repo" },
						],
					};
					expect(yield* store.compareMasterOwnership("account", 0, first)).toBe(
						true,
					);
					expect(
						yield* store.compareMasterOwnership("account", 0, {
							...first,
							masterId: "other",
						}),
					).toBe(false);
					const results = yield* Effect.all(
						[
							store.compareMasterOwnership("account", 1, {
								...first,
								homeEnvironmentId: "cloud",
								generation: 2,
							}),
							store.compareMasterOwnership("account", 1, {
								...first,
								homeEnvironmentId: "third",
								generation: 2,
							}),
						],
						{ concurrency: 2 },
					);
					expect(results.filter(Boolean)).toHaveLength(1);
					expect(
						(yield* store.getMasterOwnership("account", "master"))?.generation,
					).toBe(2);
					expect(
						yield* store.compareMasterOwnership("account", 1, {
							...first,
							generation: 2,
						}),
					).toBe(false);
					expect(
						yield* store.getMasterOwnership("different-account", "master"),
					).toBeNull();
					expect(
						yield* store.compareMasterOwnership("different-account", 0, first),
					).toBe(true);
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});
});
