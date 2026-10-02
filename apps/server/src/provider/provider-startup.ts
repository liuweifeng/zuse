import type { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Effect, Exit } from "effect";
import type { ProviderSessionRegistry } from "./provider-session-registry.ts";

/** Admission and reservation share the lifecycle lock; a rejected startup cannot evict anything. */
export const reserveProviderStartup = <Id, Entry>(input: {
	readonly registry: ProviderSessionRegistry<Id, Entry>;
	readonly lifecycle: KeyedEffectSerialWorker<Id>;
	readonly sessionId: Id;
	readonly admit: Effect.Effect<boolean>;
	readonly matches: (entry: Entry) => boolean;
	readonly detachQuestions: Effect.Effect<void>;
	readonly closeEntry: (entry: Entry) => Effect.Effect<void>;
}) =>
	input.lifecycle.run(
		input.sessionId,
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				if (!(yield* restore(input.admit)))
					return { _tag: "rejected" as const };
				const existing = input.registry.lookup(input.sessionId);
				if (existing !== undefined && input.matches(existing))
					return {
						_tag: "reuse" as const,
						entry: existing,
						generation: input.registry.currentGeneration(input.sessionId),
					};
				const removed = input.registry.invalidate(input.sessionId);
				const generation = input.registry.begin(input.sessionId);
				let released = false;
				const releaseDisplaced = Effect.uninterruptible(
					Effect.suspend(() => {
						if (released || removed === undefined) return Effect.void;
						released = true;
						return input.closeEntry(removed);
					}),
				);
				yield* Effect.addFinalizer((exit) =>
					releaseDisplaced.pipe(
						Effect.andThen(
							Exit.isFailure(exit)
								? Effect.sync(() => {
										input.registry.invalidateIfCurrent(
											input.sessionId,
											generation,
										);
									})
								: Effect.void,
						),
					),
				);
				yield* restore(input.detachQuestions);
				return { _tag: "start" as const, generation, releaseDisplaced };
			}),
		),
	);

/** Returned handles transfer out of the startup scope only on successful publication and return. */
export const acquireStartupHandle = <Handle, E, R>(
	acquire: Effect.Effect<Handle, E, R>,
	options: {
		readonly close: (handle: Handle) => Effect.Effect<void>;
		readonly abandon: Effect.Effect<void>;
	},
) =>
	Effect.gen(function* () {
		let published = false;
		const handle = yield* Effect.acquireRelease(
			acquire,
			(handle, exit) =>
				published && Exit.isSuccess(exit)
					? Effect.void
					: options.abandon.pipe(Effect.andThen(options.close(handle))),
			{ interruptible: true },
		);
		return {
			handle,
			markPublished: () => {
				published = true;
			},
		};
	});
