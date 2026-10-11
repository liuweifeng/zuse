import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "vitest";
import { closeProviderHandle } from "../../src/provider/provider-handle-cleanup.ts";
import { makeProviderSessionRegistry } from "../../src/provider/provider-session-registry.ts";
import {
	acquireStartupHandle,
	reserveProviderStartup,
} from "../../src/provider/provider-startup.ts";

it("bounds cleanup even when called from an uninterruptible finalizer", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const closing = yield* Deferred.make<void>();
			const cleanup = yield* Effect.forkScoped(
				Effect.uninterruptible(
					closeProviderHandle({
						close: () =>
							Deferred.succeed(closing, undefined).pipe(
								Effect.andThen(Effect.never),
							),
					}),
				),
			);
			yield* Deferred.await(closing);
			yield* TestClock.adjust("5 seconds");
			yield* Fiber.join(cleanup);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	);
});

it("does not evict the replacement when an older admission arrives late", async () => {
	const registry = makeProviderSessionRegistry<string, string>();
	const lifecycle = new KeyedEffectSerialWorker<string>();
	let detached = 0;
	const generation = registry.begin("session");
	registry.publish("session", generation, "replacement");
	const result = await Effect.runPromise(
		Effect.scoped(
			reserveProviderStartup({
				registry,
				lifecycle,
				sessionId: "session",
				admit: Effect.succeed(false),
				matches: () => false,
				closeEntry: () => Effect.void,
				detachQuestions: Effect.sync(() => {
					detached++;
				}),
			}),
		),
	);
	expect(result).toEqual({ _tag: "rejected" });
	expect(registry.lookup("session")).toBe("replacement");
	expect(registry.currentGeneration("session")).toBe(generation);
	expect(detached).toBe(0);
});

it("serializes admission before reservation so a later attempt owns publication", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const registry = makeProviderSessionRegistry<string, string>();
				const lifecycle = new KeyedEffectSerialWorker<string>();
				const checking = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const reserve = (admit: Effect.Effect<boolean>) =>
					reserveProviderStartup({
						registry,
						lifecycle,
						sessionId: "session",
						admit,
						matches: () => false,
						closeEntry: () => Effect.void,
						detachQuestions: Effect.void,
					});
				const first = yield* Effect.forkScoped(
					reserve(
						Deferred.succeed(checking, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as(true),
						),
					),
				);
				yield* Deferred.await(checking);
				const second = yield* Effect.forkScoped(reserve(Effect.succeed(true)));
				yield* Deferred.succeed(release, undefined);
				const old = yield* Fiber.join(first);
				const current = yield* Fiber.join(second);
				if (old._tag !== "start" || current._tag !== "start")
					throw new Error("expected starts");
				expect(registry.publish("session", current.generation, "current")).toBe(
					true,
				);
				expect(registry.publish("session", old.generation, "obsolete")).toBe(
					false,
				);
				expect(registry.lookup("session")).toBe("current");
			}),
		),
	);
});

it("closes a displaced handle when cancellation interrupts question detachment", async () => {
	const closed: string[] = [];
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const registry = makeProviderSessionRegistry<string, string>();
				registry.publish("session", registry.begin("session"), "old");
				const detaching = yield* Deferred.make<void>();
				const startup = yield* Effect.forkScoped(
					Effect.scoped(
						reserveProviderStartup({
							registry,
							lifecycle: new KeyedEffectSerialWorker<string>(),
							sessionId: "session",
							admit: Effect.succeed(true),
							matches: () => false,
							closeEntry: (entry) =>
								Effect.sync(() => {
									closed.push(entry);
								}),
							detachQuestions: Deferred.succeed(detaching, undefined).pipe(
								Effect.andThen(Effect.never),
							),
						}),
					),
				);
				yield* Deferred.await(detaching);
				yield* Fiber.interrupt(startup);
				expect(registry.lookup("session")).toBeUndefined();
			}),
		),
	);
	expect(closed).toEqual(["old"]);
});

it("releases displacement only once and never invalidates a newer generation", async () => {
	const closed: string[] = [];
	const registry = makeProviderSessionRegistry<string, string>();
	registry.publish("session", registry.begin("session"), "old");
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const reserved = yield* reserveProviderStartup({
					registry,
					lifecycle: new KeyedEffectSerialWorker<string>(),
					sessionId: "session",
					admit: Effect.succeed(true),
					matches: () => false,
					detachQuestions: Effect.void,
					closeEntry: (entry) =>
						Effect.sync(() => {
							closed.push(entry);
						}),
				});
				if (reserved._tag !== "start") throw new Error("Expected reservation");
				yield* reserved.releaseDisplaced;
				registry.publish("session", registry.begin("session"), "new");
				return yield* Effect.fail("startup failed");
			}),
		).pipe(Effect.result),
	);
	expect(closed).toEqual(["old"]);
	expect(registry.lookup("session")).toBe("new");
});

it.each([
	false,
	true,
])("closes an acquired handle on interruption (published: %s)", async (published) => {
	let closed = 0;
	let abandoned = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const acquired = yield* Deferred.make<void>();
				const startup = yield* Effect.forkScoped(
					Effect.scoped(
						Effect.gen(function* () {
							const resource = yield* acquireStartupHandle(
								Effect.succeed("handle"),
								{
									close: () =>
										Effect.sync(() => {
											closed++;
										}),
									abandon: Effect.sync(() => {
										abandoned++;
									}),
								},
							);
							if (published) resource.markPublished();
							yield* Deferred.succeed(acquired, undefined);
							yield* Effect.never;
						}),
					),
				);
				yield* Deferred.await(acquired);
				yield* Fiber.interrupt(startup);
			}),
		),
	);
	expect(closed).toBe(1);
	expect(abandoned).toBe(1);
});

it.each([
	false,
	true,
])("transfers a handle only after successful publication (published: %s)", async (published) => {
	let closed = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const resource = yield* acquireStartupHandle(Effect.succeed("handle"), {
					close: () =>
						Effect.sync(() => {
							closed++;
						}),
					abandon: Effect.void,
				});
				if (published) resource.markPublished();
			}),
		),
	);
	expect(closed).toBe(published ? 0 : 1);
});
