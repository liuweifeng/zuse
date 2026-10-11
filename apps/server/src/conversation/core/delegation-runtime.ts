import {
	AgentItemId,
	type MessageContent,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { makeSqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { renderHandoffContext } from "./context-handoff.ts";
import { makeContextLinks } from "./context-links.ts";
import { messageFromRecord } from "./conversation-records.ts";

interface DelegationRow {
	readonly child_session_id: string;
	readonly child_turn_id: string;
	readonly parent_session_id: string;
	readonly parent_turn_id: string;
	readonly parent_attempt_id: string;
	readonly provider_session_id: string;
	readonly result_message_id: string | null;
	readonly created_at: number;
}
const ended = new Set(["completed", "interrupted", "failed", "rolled_back"]);

/** Durable lineage owns cancellation and exactly-once result capture, independently of native client attachments. */
export const makeDelegationRuntime = (
	sql: SqlClient.SqlClient,
	domain: SessionDomainApi,
) => {
	const links = makeContextLinks(sql);
	const queries = makeSqlSessionQueries(sql);
	const state = (row: DelegationRow) =>
		sql<{
			parent_exists: number;
			delegation_cancelled_at: number | null;
			archived_at: string | null;
			parent_status: string | null;
			parent_phase: string | null;
			parent_attempt: string | null;
			child_exists: number;
			child_status: string | null;
			child_turn_id: string | null;
			child_title: string | null;
			child_model: string | null;
		}>`SELECT d.cancelled_at AS delegation_cancelled_at,EXISTS(SELECT 1 FROM sessions WHERE id=${row.parent_session_id}) AS parent_exists,
  parent.archived_at,pt.status AS parent_status,pt.phase AS parent_phase,pt.active_attempt_id AS parent_attempt,
  EXISTS(SELECT 1 FROM sessions WHERE id=${row.child_session_id}) AS child_exists,
  ct.status AS child_status,ct.id AS child_turn_id,child.title AS child_title,child.model AS child_model
  FROM session_delegations d
  LEFT JOIN sessions parent ON parent.id=d.parent_session_id
  LEFT JOIN session_turns pt ON pt.id=d.parent_turn_id AND pt.session_id=d.parent_session_id
  LEFT JOIN sessions child ON child.id=d.child_session_id
  LEFT JOIN session_turns ct ON ct.id=(SELECT latest.id FROM session_turns latest WHERE latest.session_id=d.child_session_id ORDER BY latest.ordinal DESC LIMIT 1)
  WHERE d.child_session_id=${row.child_session_id}`.pipe(
			Effect.map((rows) => rows[0]),
		);
	const cancelled = (
		current: NonNullable<Effect.Success<ReturnType<typeof state>>>,
	) =>
		current.parent_exists !== 1 ||
		current.archived_at !== null ||
		current.parent_status === null ||
		current.parent_status === "failed" ||
		current.parent_status === "interrupted" ||
		current.parent_status === "rolled_back" ||
		current.parent_phase === "interrupt-requested" ||
		current.parent_phase === "interrupt-acknowledged";
	const revoked = (
		row: DelegationRow,
		current: NonNullable<Effect.Success<ReturnType<typeof state>>>,
	) =>
		current.delegation_cancelled_at !== null ||
		cancelled(current) ||
		current.parent_attempt !== row.parent_attempt_id;
	const pendingDescendants = (
		row: DelegationRow,
	) => sql`WITH RECURSIVE tree(id) AS (SELECT ${row.child_session_id} UNION SELECT d.child_session_id FROM session_delegations d JOIN tree ON d.parent_session_id=tree.id WHERE d.cancelled_at IS NULL)
 SELECT 1 FROM session_delegations d JOIN tree ON d.parent_session_id=tree.id LEFT JOIN session_turns wake ON wake.id=d.wake_turn_id
 WHERE d.cancelled_at IS NULL AND (d.wake_turn_id IS NULL OR wake.status IN ('starting','running','finalizing')) LIMIT 1`;
	const reconcile = (row: DelegationRow) =>
		Effect.gen(function* () {
			const current = yield* state(row);
			if (current === undefined) return;
			if (revoked(row, current)) {
				if (
					current.child_exists === 1 &&
					current.child_status !== null &&
					!ended.has(current.child_status) &&
					current.child_status !== "finalizing"
				) {
					yield* domain.dispatchTransactionally(
						{
							streamId: row.child_session_id,
							commandId: `delegation:cancel:${row.child_session_id}`,
							command: {
								_tag: "RequestTurnInterrupt",
								expectedTurnId: current.child_turn_id ?? row.child_turn_id,
								requestedAt: Date.now(),
							},
						},
						() =>
							Effect.gen(function* () {
								const latest = yield* state(row);
								if (latest !== undefined && !revoked(row, latest))
									return yield* Effect.fail(
										new Error("Delegation parent changed before cancellation."),
									);
								yield* sql`UPDATE session_delegations SET cancelled_at=${Date.now()} WHERE child_session_id=${row.child_session_id}`;
							}),
					);
				} else
					yield* sql`UPDATE session_delegations SET cancelled_at=${Date.now()} WHERE child_session_id=${row.child_session_id}`;
				return;
			}
			if (
				row.result_message_id !== null ||
				(current.child_exists === 1 && !ended.has(current.child_status ?? ""))
			)
				return;
			// A child response is not its final result while nested work or its completion continuation is pending.
			const descendants = yield* pendingDescendants(row);
			if (descendants.length > 0) return;
			const rows = yield* queries.messageList({
				sessionId: row.child_session_id,
				kinds: ["assistant", "tool_use", "tool_result", "subagent_summary"],
				direction: "desc",
				limit: 201,
			});
			const context = renderHandoffContext(
				rows.slice(0, 200).reverse().map(messageFromRecord),
				rows.length > 200,
			);
			const resultId = MessageId.make(
				`delegation-result:${row.child_session_id}`,
			);
			const status = current.child_status ?? "deleted";
			const content: MessageContent = {
				_tag: "subagent_summary",
				itemId: AgentItemId.make(`delegation:${row.child_session_id}`),
				agentName: current.child_title ?? "Delegated work",
				model: current.child_model ?? "unknown",
				turns: 1,
				durationMs: Math.max(0, Date.now() - row.created_at),
				summary: `Delegated work ${status}.\n\n${context}`,
				isError: status !== "completed",
				childSessionId: row.child_session_id,
				presentation: "detached",
			};
			yield* domain.dispatchTransactionally(
				{
					streamId: row.parent_session_id,
					commandId: `delegation:result:${row.child_session_id}`,
					command: {
						_tag: "PersistMessage",
						messageId: resultId,
						turnId: row.parent_turn_id,
						role: "assistant",
						kind: content._tag,
						contentJson: JSON.stringify(content),
						parentItemId: null,
						createdAt: Date.now(),
					},
				},
				() =>
					Effect.gen(function* () {
						const latest = yield* state(row);
						if (
							latest === undefined ||
							revoked(row, latest) ||
							latest.child_turn_id !== current.child_turn_id ||
							latest.child_status !== current.child_status ||
							(yield* pendingDescendants(row)).length > 0
						)
							return yield* Effect.fail(
								new Error("Delegation parent changed before result capture."),
							);
						yield* links.capture({
							id: `delegation:${row.child_session_id}`,
							kind: "subagent_result",
							sourceSessionId: SessionId.make(row.child_session_id),
							targetSessionId: SessionId.make(row.parent_session_id),
							targetMessageId: resultId,
							baseMessageId: null,
							sourceMessageId:
								rows[0] === undefined
									? null
									: MessageId.make(rows[0].messageId),
							sourceSequence: rows[0]?.sequence ?? 0,
							contextText: content.summary,
							originTurnId: row.parent_turn_id,
							originAttemptId: row.parent_attempt_id,
						});
						yield* sql`UPDATE session_delegations SET result_message_id=${resultId},result_status=${status} WHERE child_session_id=${row.child_session_id}`;
					}),
			);
		});
	const wake = (row: DelegationRow) =>
		Effect.gen(function* () {
			const current = yield* state(row);
			if (
				current === undefined ||
				revoked(row, current) ||
				current.parent_status !== "completed"
			)
				return;
			const ready =
				yield* sql`SELECT 1 FROM session_delegations WHERE parent_session_id=${row.parent_session_id} AND parent_turn_id=${row.parent_turn_id} AND parent_attempt_id=${row.parent_attempt_id} AND cancelled_at IS NULL AND (result_message_id IS NULL OR wake_turn_id IS NOT NULL) LIMIT 1`;
			if (ready.length > 0) return;
			const delivery = yield* sql<{
				invalidated: number;
				pending: number;
				delivered_turn: string | null;
			}>`SELECT
             SUM(CASE WHEN l.invalidated_at IS NOT NULL THEN 1 ELSE 0 END) AS invalidated,
             SUM(CASE WHEN l.first_turn_id IS NULL THEN 1 ELSE 0 END) AS pending,
             MAX(l.first_turn_id) AS delivered_turn
             FROM session_delegations d JOIN session_context_links l ON l.id='delegation:' || d.child_session_id
             WHERE d.parent_session_id=${row.parent_session_id} AND d.parent_turn_id=${row.parent_turn_id} AND d.parent_attempt_id=${row.parent_attempt_id} AND d.cancelled_at IS NULL`;
			if ((delivery[0]?.invalidated ?? 0) > 0) {
				yield* sql`UPDATE session_delegations SET cancelled_at=${Date.now()} WHERE parent_session_id=${row.parent_session_id} AND parent_turn_id=${row.parent_turn_id} AND parent_attempt_id=${row.parent_attempt_id} AND cancelled_at IS NULL`;
				return;
			}
			if (delivery[0]?.pending === 0 && delivery[0].delivered_turn !== null) {
				yield* sql`UPDATE session_delegations SET wake_turn_id=${delivery[0].delivered_turn} WHERE parent_session_id=${row.parent_session_id} AND parent_turn_id=${row.parent_turn_id} AND parent_attempt_id=${row.parent_attempt_id} AND cancelled_at IS NULL`;
				return;
			}
			const busy =
				yield* sql`SELECT 1 FROM sessions s WHERE s.id=${row.parent_session_id} AND (s.queue_paused=1 OR EXISTS(SELECT 1 FROM session_turns t WHERE t.session_id=s.id AND t.status IN ('starting','running','finalizing'))) LIMIT 1`;
			if (busy.length > 0) return;
			const turnId = `delegation-wake:${row.parent_turn_id}:${row.parent_attempt_id}`;
			const sources = yield* sql<{
				session_id: string;
				chat_id: string;
				provider_id: string;
				title: string;
			}>`SELECT child.id AS session_id,child.chat_id,child.provider_id,child.title
                FROM session_delegations d JOIN sessions child ON child.id=d.child_session_id
                WHERE d.parent_session_id=${row.parent_session_id} AND d.parent_turn_id=${row.parent_turn_id}
                AND d.parent_attempt_id=${row.parent_attempt_id} AND d.cancelled_at IS NULL
                ORDER BY d.created_at,d.child_session_id`;
			const origins = sources.map((source) => ({
				sessionId: source.session_id,
				chatId: source.chat_id,
				providerId: source.provider_id,
				title: source.title,
			}));

			const text =
				"Your delegated work has finished. Review the attached child results and continue the parent task if needed.";
			yield* domain.dispatchTransactionally(
				{
					streamId: row.parent_session_id,
					commandId: `delegation:wake:${row.parent_turn_id}:${row.parent_attempt_id}`,
					command: {
						_tag: "SubmitTurn",
						turnId,
						messageId: `delegation-wake-message:${row.parent_turn_id}:${row.parent_attempt_id}`,
						role: "user",
						kind: "user",
						contentJson: JSON.stringify({
							_tag: "user",
							text,
							goal: false,
							...(origins.length
								? {
										origins,
										...(origins.length === 1 ? { origin: origins[0] } : {}),
									}
								: {}),
						}),
						parentItemId: null,
						providerInputJson: JSON.stringify({
							text,
							attachments: [],
							fileRefs: [],
							skillRefs: [],
							annotations: [],
						}),
						createdAt: Date.now(),
					},
				},
				() =>
					Effect.gen(function* () {
						const latest = yield* state(row);
						if (
							latest === undefined ||
							revoked(row, latest) ||
							latest.parent_status !== "completed"
						)
							return yield* Effect.fail(
								new Error("Parent changed before completion wake."),
							);
						const paused =
							yield* sql`SELECT 1 FROM sessions WHERE id=${row.parent_session_id} AND queue_paused=1`;
						const invalid =
							yield* sql`SELECT 1 FROM session_delegations d JOIN session_context_links l ON l.id='delegation:' || d.child_session_id WHERE d.parent_session_id=${row.parent_session_id} AND d.parent_turn_id=${row.parent_turn_id} AND d.parent_attempt_id=${row.parent_attempt_id} AND l.invalidated_at IS NOT NULL LIMIT 1`;
						if (paused.length > 0 || invalid.length > 0)
							return yield* Effect.fail(
								new Error("Delegated completion delivery changed before wake."),
							);
						yield* sql`UPDATE session_delegations SET wake_turn_id=${turnId} WHERE parent_session_id=${row.parent_session_id} AND parent_turn_id=${row.parent_turn_id} AND parent_attempt_id=${row.parent_attempt_id} AND cancelled_at IS NULL`;
					}),
			);
		});
	const sweep = Effect.gen(function* () {
		// Eligible rows only: long-running parents cannot starve later completed work.
		const rows = yield* sql<DelegationRow>`SELECT d.* FROM session_delegations d
   LEFT JOIN sessions parent ON parent.id=d.parent_session_id
   LEFT JOIN session_turns pt ON pt.id=d.parent_turn_id AND pt.session_id=d.parent_session_id
   LEFT JOIN sessions child ON child.id=d.child_session_id
   LEFT JOIN session_turns ct ON ct.id=(SELECT latest.id FROM session_turns latest WHERE latest.session_id=d.child_session_id ORDER BY latest.ordinal DESC LIMIT 1)
   WHERE d.cancelled_at IS NULL AND d.wake_turn_id IS NULL AND (
    parent.id IS NULL OR parent.archived_at IS NOT NULL OR pt.id IS NULL OR pt.active_attempt_id<>d.parent_attempt_id OR pt.status IN ('interrupted','failed','rolled_back') OR pt.phase IN ('interrupt-requested','interrupt-acknowledged') OR
    (d.result_message_id IS NULL AND (child.id IS NULL OR ct.status IN ('completed','interrupted','failed','rolled_back'))))
   ORDER BY d.created_at,d.child_session_id LIMIT 100`;
		for (const row of rows)
			yield* reconcile(row).pipe(
				Effect.catchCause(() =>
					Effect.logWarning("Delegated work reconciliation will retry."),
				),
			);
		const groups =
			yield* sql<DelegationRow>`SELECT d.* FROM session_delegations d JOIN session_turns pt ON pt.id=d.parent_turn_id AND pt.session_id=d.parent_session_id
   WHERE d.cancelled_at IS NULL AND d.wake_turn_id IS NULL AND d.result_message_id IS NOT NULL AND pt.status='completed'
   AND NOT EXISTS(SELECT 1 FROM session_delegations sibling WHERE sibling.parent_session_id=d.parent_session_id AND sibling.parent_turn_id=d.parent_turn_id AND sibling.parent_attempt_id=d.parent_attempt_id AND sibling.cancelled_at IS NULL AND (sibling.result_message_id IS NULL OR sibling.wake_turn_id IS NOT NULL))
   GROUP BY d.parent_session_id,d.parent_turn_id,d.parent_attempt_id
   ORDER BY EXISTS(SELECT 1 FROM sessions s WHERE s.id=d.parent_session_id AND (s.queue_paused=1 OR EXISTS(SELECT 1 FROM session_turns t WHERE t.session_id=s.id AND t.status IN ('starting','running','finalizing')))),d.created_at LIMIT 100`;
		for (const row of groups)
			yield* wake(row).pipe(
				Effect.catchCause(() =>
					Effect.logWarning("Delegated completion wake will retry."),
				),
			);
	});
	return { sweep };
};
