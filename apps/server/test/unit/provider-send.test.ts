import { ProviderHandleUnavailable } from "@zuse/agents/kernel/turn-protocol";
import { AgentSessionId, AgentTurnId, AttemptId } from "@zuse/contracts";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { expect, it } from "vitest";
import { sendProviderSession } from "../../src/provider/provider-send.ts";
import { makeProviderSessionRegistry } from "../../src/provider/provider-session-registry.ts";

const sessionId = AgentSessionId.make("session");
const ownership = {
	turnId: AgentTurnId.make("turn"),
	attemptId: AttemptId.make("attempt"),
};
const fixture = () => {
	let closed = 0;
	const entry = {
		providerSessionId: "old",
		ownership,
		handle: {
			close: () =>
				Effect.sync(() => {
					closed++;
				}),
		},
	};
	const registry = makeProviderSessionRegistry<AgentSessionId, typeof entry>();
	registry.publish(sessionId, registry.begin(sessionId, "old"), entry);
	return { entry, registry, closed: () => closed };
};

it.each([
	"stop",
	"pending replacement",
	"published replacement",
] as const)("rejects send after %s during preparation", async (action) => {
	const { entry, registry } = fixture();
	let sends = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkChild(
					sendProviderSession({
						registry,
						sessionId,
						entry,
						ownership,
						prepare: Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(resume)),
						),
						send: () => {
							sends++;
							return Effect.void;
						},
					}),
				);
				yield* Deferred.await(entered);
				if (action === "stop") registry.invalidate(sessionId);
				else {
					const generation = registry.begin(sessionId, "new");
					if (action === "published replacement")
						registry.publish(sessionId, generation, {
							...entry,
							providerSessionId: "new",
						});
				}
				yield* Deferred.succeed(resume, undefined);
				expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
			}),
		),
	);
	expect(sends).toBe(0);
});

it("does not invalidate a pending replacement when the old handle rejects a send", async () => {
	const { entry, registry, closed } = fixture();
	const result = await Effect.runPromise(
		Effect.exit(
			sendProviderSession({
				registry,
				sessionId,
				entry,
				ownership,
				prepare: Effect.void,
				send: () =>
					Effect.suspend(() => {
						registry.begin(sessionId, "new");
						return Effect.fail(
							new ProviderHandleUnavailable({ reason: "closed" }),
						);
					}),
			}),
		),
	);
	expect(Exit.isFailure(result)).toBe(true);
	expect(registry.currentProviderSessionId(sessionId)).toBe("new");
	expect(closed()).toBe(1);
});

it("checks attempt ownership before preparation and sends once for its owner", async () => {
	const { entry, registry } = fixture();
	let prepared = 0;
	let sends = 0;
	const input = {
		registry,
		sessionId,
		entry,
		prepare: Effect.sync(() => {
			prepared++;
		}),
		send: () =>
			Effect.sync(() => {
				sends++;
			}),
	};
	const stale = await Effect.runPromise(
		Effect.exit(
			sendProviderSession({
				...input,
				ownership: { ...ownership, attemptId: AttemptId.make("other") },
			}),
		),
	);
	expect(Exit.isFailure(stale)).toBe(true);
	expect(prepared).toBe(0);
	await Effect.runPromise(sendProviderSession({ ...input, ownership }));
	expect(prepared).toBe(1);
	expect(sends).toBe(1);
});

it.each([
	"preparation",
	"driver",
] as const)("cancellation during %s closes only the sending handle", async (stage) => {
	const { entry, registry, closed } = fixture();
	let replacementClosed = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const block = Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Effect.never),
				);
				const fiber = yield* Effect.forkChild(
					sendProviderSession({
						registry,
						sessionId,
						entry,
						ownership,
						prepare: stage === "preparation" ? block : Effect.void,
						send: () => (stage === "driver" ? block : Effect.void),
					}),
				);
				yield* Deferred.await(entered);
				const replacement = {
					...entry,
					providerSessionId: "new",
					handle: {
						close: () =>
							Effect.sync(() => {
								replacementClosed++;
							}),
					},
				};
				registry.publish(
					sessionId,
					registry.begin(sessionId, "new"),
					replacement,
				);
				yield* Fiber.interrupt(fiber);
				expect(registry.lookup(sessionId)).toBe(replacement);
			}),
		),
	);
	expect(closed()).toBe(1);
	expect(replacementClosed).toBe(0);
});

it("retires an unavailable current handle so later sends cannot reuse it", async () => {
	const { entry, registry, closed } = fixture();
	const result = await Effect.runPromise(
		Effect.exit(
			sendProviderSession({
				registry,
				sessionId,
				entry,
				ownership,
				prepare: Effect.void,
				send: () =>
					Effect.fail(
						new ProviderHandleUnavailable({ reason: "stream ended" }),
					),
			}),
		),
	);
	expect(Exit.isFailure(result)).toBe(true);
	expect(registry.lookup(sessionId)).toBeUndefined();
	expect(closed()).toBe(1);
});
