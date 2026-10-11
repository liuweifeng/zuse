import { Deferred, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { makeProviderSessionRegistry } from "../../src/provider/provider-session-registry.ts";
import {
	retireProviderSession,
	stopProviderSession,
} from "../../src/provider/provider-stop.ts";

it.each([
	"old",
	null,
])("does not retire a replacement for stop target %s", (target) => {
	const registry = makeProviderSessionRegistry<
		string,
		{ providerSessionId: string }
	>();
	const generation = registry.begin("session");
	const replacement = { providerSessionId: "new" };
	registry.publish("session", generation, replacement);
	expect(retireProviderSession(registry, "session", undefined, target)).toEqual(
		{ _tag: "obsolete" },
	);
	expect(registry.lookup("session")).toBe(replacement);
	expect(registry.currentGeneration("session")).toBe(generation);
});

it.each([
	"old",
	null,
])("does not invalidate an unpublished startup for stop target %s", (target) => {
	const registry = makeProviderSessionRegistry<
		string,
		{ providerSessionId: string }
	>();
	const generation = registry.begin("session");
	expect(retireProviderSession(registry, "session", undefined, target)).toEqual(
		{ _tag: "obsolete" },
	);
	expect(
		registry.publish("session", generation, { providerSessionId: "new" }),
	).toBe(true);
});

it("retires only the captured matching entry", () => {
	const registry = makeProviderSessionRegistry<
		string,
		{ providerSessionId: string }
	>();
	const entry = { providerSessionId: "old" };
	registry.publish("session", registry.begin("session"), entry);
	expect(retireProviderSession(registry, "session", undefined, "old")).toEqual({
		_tag: "retired",
		entry,
	});
	expect(registry.lookup("session")).toBeUndefined();
});

it("closes the retired handle when question detachment is cancelled", async () => {
	let closed = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const handle = {
					close: () =>
						Effect.sync(() => {
							closed++;
						}),
				};
				const registry = makeProviderSessionRegistry<
					string,
					{ providerSessionId: string; handle: typeof handle }
				>();
				registry.publish("session", registry.begin("session"), {
					providerSessionId: "old",
					handle,
				});
				const detaching = yield* Deferred.make<void>();
				const stop = yield* Effect.forkScoped(
					stopProviderSession({
						registry,
						sessionId: "session",
						expectedProviderSessionId: "old",
						detachQuestions: Deferred.succeed(detaching, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					}),
				);
				yield* Deferred.await(detaching);
				const replacement = { providerSessionId: "new", handle };
				registry.publish("session", registry.begin("session"), replacement);
				yield* Fiber.interrupt(stop);
				expect(registry.lookup("session")).toBe(replacement);
			}),
		),
	);
	expect(closed).toBe(1);
});

it("revokes a matching unpublished reservation before its handle can publish", () => {
	const registry = makeProviderSessionRegistry<
		string,
		{ providerSessionId: string }
	>();
	const generation = registry.begin("session", "pending");
	expect(
		retireProviderSession(registry, "session", undefined, "pending"),
	).toEqual({ _tag: "retired", entry: undefined });
	expect(
		registry.publish("session", generation, { providerSessionId: "pending" }),
	).toBe(false);
	const replacement = registry.begin("session", "replacement");
	expect(
		retireProviderSession(registry, "session", undefined, "pending"),
	).toEqual({ _tag: "obsolete" });
	expect(
		registry.publish("session", replacement, {
			providerSessionId: "replacement",
		}),
	).toBe(true);
});
