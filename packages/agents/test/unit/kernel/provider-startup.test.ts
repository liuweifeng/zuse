import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import { withProviderStartup } from "../../../src/kernel/provider-startup.ts";

describe("provider startup ownership", () => {
	it("closes acquired resources when interrupted during a handshake", async () => {
		const close = vi.fn();
		await Effect.runPromise(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const fiber = yield* withProviderStartup(function* (startup) {
					startup.add(close);
					yield* Deferred.succeed(entered, undefined);
					yield* Effect.never;
					return { close: () => Effect.sync(close) };
				}).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				yield* Fiber.interrupt(fiber);
			}),
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("releases a late Promise allocation after its awaiting fiber is gone", async () => {
		let allocate!: (resource: { close: () => void }) => void;
		const allocated = new Promise<{ close: () => void }>((resolve) => {
			allocate = resolve;
		});
		const started = await Effect.runPromise(Deferred.make<void>());
		const released = await Effect.runPromise(Deferred.make<void>());
		const close = vi.fn(() =>
			Effect.runSync(Deferred.succeed(released, undefined)),
		);
		const program = withProviderStartup(function* (startup) {
			yield* Effect.promise(() =>
				startup.acquire(
					() => {
						Effect.runSync(Deferred.succeed(started, undefined));
						return allocated;
					},
					(resource) => resource.close(),
				),
			);
			return { close: () => Effect.sync(close) };
		});
		const fiber = Effect.runFork(program);
		await Effect.runPromise(Deferred.await(started));
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(close).not.toHaveBeenCalled();
		allocate({ close });
		await Effect.runPromise(Deferred.await(released));
		expect(close).toHaveBeenCalledOnce();
	});

	it.each([
		"failure",
		"defect",
	] as const)("cleans up after a %s without replacing the cause", async (kind) => {
		const close = vi.fn();
		const cause = new Error("startup failed");
		const exit = await Effect.runPromiseExit(
			withProviderStartup(function* (startup) {
				startup.add(close);
				yield* kind === "failure" ? Effect.fail(cause) : Effect.die(cause);
				return { close: () => Effect.void };
			}),
		);
		expect(exit).toEqual(
			kind === "failure" ? Exit.fail(cause) : Exit.die(cause),
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("hands successful resources to the handle without closing them", async () => {
		const close = vi.fn();
		const handle = await Effect.runPromise(
			withProviderStartup(function* (startup) {
				const resource = yield* Effect.promise(() =>
					startup.acquire(
						async () => ({ close }),
						(value) => value.close(),
					),
				);
				return { close: () => Effect.sync(resource.close) };
			}),
		);
		expect(close).not.toHaveBeenCalled();
		await Effect.runPromise(handle.close());
		expect(close).toHaveBeenCalledOnce();
	});
	it("bounds cleanup and releases other resources even when one close never resolves", async () => {
		vi.useFakeTimers();
		const warning = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const close = vi.fn();
		try {
			const cause = new Error("startup failed");
			const result = Effect.runPromiseExit(
				withProviderStartup(function* (startup) {
					startup.add(() => new Promise<void>(() => undefined));
					startup.add(close);
					return yield* Effect.fail(cause);
				}),
			);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await result).toEqual(Exit.fail(cause));
			expect(close).toHaveBeenCalledOnce();
			expect(warning).toHaveBeenCalledOnce();
		} finally {
			warning.mockRestore();
			vi.useRealTimers();
		}
	});
});
