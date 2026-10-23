import { Deferred, type Duration, Effect, Exit } from "effect";

/** One physical callback delivery, owned by the input rather than an RPC connection. */
export const makeInputCallbackDelivery = <E>(options: {
	readonly isCurrent: () => boolean;
	readonly unavailable: () => E;
	readonly timeout: Duration.Input;

	readonly retryFailures: boolean;
}) => {
	const revoked = Deferred.makeUnsafe<never, E>();
	let isRevoked = false;
	const isCurrent = () => !isRevoked && options.isCurrent();
	let delivery:
		| { key: string; completion: Deferred.Deferred<void, E> }
		| undefined;
	return {
		revoke: () => {
			isRevoked = true;
			Deferred.doneUnsafe(revoked, Effect.fail(options.unavailable()));
		},
		run: <R>(
			key: string,
			invoke: Effect.Effect<void, E, R>,
		): Effect.Effect<void, E, R> =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if (!isCurrent()) return yield* Effect.fail(options.unavailable());
					if (delivery !== undefined) {
						if (delivery.key !== key)
							return yield* Effect.fail(options.unavailable());
						return yield* restore(Deferred.await(delivery.completion));
					}
					const completion = yield* Deferred.make<void, E>();
					delivery = { key, completion };
					const bounded = Effect.suspend(() =>
						isCurrent() ? invoke : Effect.fail(options.unavailable()),
					).pipe(
						Effect.interruptible,
						Effect.raceFirst(Deferred.await(revoked)),
						Effect.timeoutOrElse({
							duration: options.timeout,
							orElse: () => Effect.fail(options.unavailable()),
						}),
					);
					const finish = Effect.exit(bounded).pipe(
						Effect.flatMap((exit) =>
							Effect.sync(() => {
								if (!isCurrent()) return Exit.fail(options.unavailable());
								if (Exit.isFailure(exit) && options.retryFailures)
									delivery = undefined;
								return exit;
							}).pipe(
								Effect.flatMap((result) => Deferred.done(completion, result)),
							),
						),
					);
					yield* Effect.forkDetach(finish);
					return yield* restore(Deferred.await(completion));
				}),
			),
	};
};
export type InputCallbackDelivery<E> = ReturnType<
	typeof makeInputCallbackDelivery<E>
>;
