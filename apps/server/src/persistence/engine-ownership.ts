import { join } from "node:path";
import { tryAcquireProcessLock } from "@zuse/sqlite";
import { Effect, Schema } from "effect";

export class EngineOwnershipError extends Schema.TaggedErrorClass<EngineOwnershipError>()(
	"EngineOwnershipError",
	{
		dataDirectory: Schema.String,
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

/** Hold ownership for the entire runtime scope, before migration or recovery. */
export const acquireEngineOwnership = (dataDirectory: string) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const lock = yield* Effect.try({
				try: () =>
					tryAcquireProcessLock(join(dataDirectory, "engine.lock.sqlite")),
				catch: (cause) =>
					new EngineOwnershipError({
						dataDirectory,
						message: "Cannot acquire Agent Engine ownership.",
						cause,
					}),
			});
			if (lock === null)
				return yield* new EngineOwnershipError({
					dataDirectory,
					message: `An Agent Engine is already running for ${dataDirectory}. Connect to that engine or stop it before starting another.`,
				});
			return lock;
		}),
		(lock) => Effect.sync(lock.release),
	).pipe(Effect.asVoid);
