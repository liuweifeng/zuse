import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export class AdmissionClosed extends Schema.TaggedErrorClass<AdmissionClosed>()(
	"AdmissionClosed",
	{},
) {}

/** A process-owned gate serialized with the same transactions that admit durable work. */
export const makeSqlAdmission = (sql: SqlClient.SqlClient) => {
	let closed = false;
	let activeOperations = 0;
	return {
		activeOperations: Effect.sync(() => activeOperations),
		withOperation: <A, E, R>(work: Effect.Effect<A, E, R>) =>
			Effect.suspend(() => {
				let acquired = false;
				return Effect.uninterruptibleMask((restore) =>
					sql
						.withTransaction(
							Effect.gen(function* () {
								if (closed) return yield* new AdmissionClosed();
								activeOperations += 1;
								acquired = true;
							}),
						)
						.pipe(
							Effect.andThen(restore(work)),
							Effect.ensuring(
								Effect.sync(() => {
									if (acquired) activeOperations -= 1;
								}),
							),
						),
				);
			}),
		run: <A, E, R>(work: Effect.Effect<A, E, R>) =>
			sql.withTransaction(
				Effect.gen(function* () {
					if (closed) return yield* new AdmissionClosed();
					return yield* work;
				}),
			),
		closeIf: <E, R>(idle: Effect.Effect<boolean, E, R>) =>
			Effect.uninterruptibleMask((restore) =>
				sql.withTransaction(
					Effect.gen(function* () {
						if (closed) return true;
						if (activeOperations > 0 || !(yield* restore(idle))) return false;
						// After the decision, cancellation cannot reopen admission while another
						// shutdown caller has already observed it closed. Commit failures stay closed.
						closed = true;
						return true;
					}),
				),
			),
	};
};
export type SqlAdmission = ReturnType<typeof makeSqlAdmission>;
