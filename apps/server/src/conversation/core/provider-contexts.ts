import type { ProviderId, SessionId } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

const decodeMessageIds = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Array(Schema.String)),
);

/** Native history coverage is recorded only at an idle provider-switch boundary. */
export const makeProviderContexts = (sql: SqlClient.SqlClient) => {
	const rememberVerified = (
		sessionId: SessionId,
		threadId: string,
		coverage: {
			readonly throughSequence: number;
			readonly pendingMessageIds: ReadonlyArray<string>;
		},
	) =>
		sql`INSERT INTO session_provider_contexts(provider_thread_id,session_id,through_sequence,pending_message_ids_json,updated_at) VALUES (${threadId},${sessionId},${coverage.throughSequence},${JSON.stringify(coverage.pendingMessageIds)},${Date.now()}) ON CONFLICT(provider_thread_id) DO UPDATE SET through_sequence=excluded.through_sequence,pending_message_ids_json=excluded.pending_message_ids_json,updated_at=excluded.updated_at`.pipe(
			Effect.asVoid,
		);

	const remember = (sessionId: SessionId, threadId: string | null) =>
		Effect.gen(function* () {
			if (threadId === null) return;
			const latest = yield* sql<{
				status: string;
			}>`SELECT status FROM session_turns WHERE session_id=${sessionId} ORDER BY ordinal DESC LIMIT 1`;

			if (latest[0] !== undefined && latest[0].status !== "completed") {
				yield* sql`DELETE FROM session_provider_contexts WHERE provider_thread_id=${threadId}`;
				return;
			}
			const bounds = yield* sql<{
				sequence: number;
			}>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM messages WHERE session_id=${sessionId}`;
			const pending = yield* sql<{
				target_message_id: string;
			}>`SELECT target_message_id FROM session_context_links WHERE target_session_id=${sessionId} AND first_turn_id IS NULL AND invalidated_at IS NULL`;
			yield* rememberVerified(sessionId, threadId, {
				throughSequence: bounds[0]?.sequence ?? 0,
				pendingMessageIds: pending.map((row) => row.target_message_id),
			});
		});
	const returning = (sessionId: SessionId, providerId: ProviderId) =>
		Effect.gen(function* () {
			if (providerId !== "claude" && providerId !== "codex") return null;
			const rows = yield* sql<{
				provider_thread_id: string;
				through_sequence: number;
				pending_message_ids_json: string;
			}>`SELECT c.provider_thread_id,c.through_sequence,c.pending_message_ids_json FROM session_provider_contexts c JOIN session_provider_threads t ON t.id=c.provider_thread_id WHERE c.session_id=${sessionId} AND t.provider=${providerId} ORDER BY c.updated_at DESC LIMIT 1`;
			const row = rows[0];
			if (row === undefined) return null;
			return {
				threadId: row.provider_thread_id,
				throughSequence: row.through_sequence,
				pendingMessageIds: yield* decodeMessageIds(
					row.pending_message_ids_json,
				),
			};
		});
	return { remember, rememberVerified, returning };
};
