import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { makeInputCallbackDelivery } from "../../src/provider/input-callback-delivery.ts";

it("retains uncertain failures instead of invoking the provider again", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const authority = makeInputCallbackDelivery({
				isCurrent: () => true,
				unavailable: () => new Error("unavailable"),
				timeout: "10 millis",
				retryFailures: false,
			});
			let calls = 0;
			const invoke = Effect.sync(() => {
				calls++;
			}).pipe(Effect.andThen(Effect.never));
			expect(
				Exit.isFailure(yield* Effect.exit(authority.run("decision", invoke))),
			).toBe(true);
			expect(
				Exit.isFailure(yield* Effect.exit(authority.run("decision", invoke))),
			).toBe(true);
			expect(
				Exit.isFailure(
					yield* Effect.exit(authority.run("different decision", invoke)),
				),
			).toBe(true);
			expect(calls).toBe(1);
		}),
	);
});

it("revocation invalidates even a retained successful delivery", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const authority = makeInputCallbackDelivery({
				isCurrent: () => true,
				unavailable: () => new Error("unavailable"),
				timeout: "1 second",
				retryFailures: false,
			});
			let calls = 0;
			const invoke = Effect.sync(() => {
				calls++;
			});
			yield* authority.run("decision", invoke);
			yield* authority.run("decision", invoke);
			authority.revoke();
			expect(
				Exit.isFailure(yield* Effect.exit(authority.run("decision", invoke))),
			).toBe(true);
			expect(calls).toBe(1);
		}),
	);
});
