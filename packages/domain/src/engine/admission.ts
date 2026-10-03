import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export class AdmissionClosed extends Schema.TaggedErrorClass<AdmissionClosed>()(
	"AdmissionClosed",
	{},
) {}

/** A process-owned gate serialized with the same transactions that admit durable work. */
export const makeSqlAdmission = (sql: SqlClient.SqlClient) => {
	let closed = false;
	return {
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
						if (!(yield* restore(idle))) return false;
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
