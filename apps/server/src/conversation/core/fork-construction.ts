import {
	type Chat,
	ChatId,
	FolderId,
	MessageContent,
	MessageId,
	PermissionMode,
	ProviderId,
	RuntimeMode,
	type Session,
	SessionContextError,
	type SessionForkConstruction,
	SessionId,
	SessionStartError,
	WorktreeId,
} from "@zuse/contracts";
import { forkMessageId } from "@zuse/domain/conversation/transcript";
import { Effect, Schema, Semaphore } from "effect";
import type {
	ConversationOperations,
	ForkSessionInput,
} from "../services/conversation-services.ts";
import { makeContextHandoff } from "./context-handoff.ts";
import type { TranscriptOperationsOptions } from "./transcript-operations.ts";

export const ForkConstruction = Schema.Struct({
	sessionId: SessionId,
	sourceSessionId: SessionId,
	chatId: ChatId,
	projectId: FolderId,
	commandId: Schema.String,
	destination: Schema.Literals(["tab", "chat"]),
	providerId: ProviderId,
	model: Schema.String,
	title: Schema.String,
	runtimeMode: RuntimeMode,
	permissionMode: PermissionMode,
	toolSearch: Schema.Boolean,
	worktreeId: Schema.NullOr(WorktreeId),
	forkedFromSessionId: Schema.NullOr(SessionId),
	forkedFromMessageId: MessageId,
	nativeChildStepId: Schema.optional(Schema.String),
	forkMode: Schema.Literals(["resume", "copy"]),
	providerThread: Schema.optional(
		Schema.Struct({
			nativeThreadId: Schema.String,
			nativeHeadId: Schema.NullOr(Schema.String),
		}),
	),
	messages: Schema.Array(
		Schema.Struct({ id: MessageId, content: MessageContent }),
	),
});
export type ForkConstruction = typeof ForkConstruction.Type;

/** A frozen plan survives source mutation, interrupted imports and engine replacement. */
export const makeForkConstruction = (options: TranscriptOperationsOptions) => {
	const { sql } = options;
	const lock = Semaphore.makeUnsafe(1);
	const handoff = makeContextHandoff(sql);
	const decode = Schema.decodeUnknownSync(ForkConstruction);
	const load = (sessionId: SessionId) =>
		sql<{
			payload_json: string;
			completed_at: number | null;
			cancelled_at: number | null;
		}>`SELECT payload_json,completed_at,cancelled_at FROM session_fork_constructions WHERE session_id=${sessionId}`.pipe(
			Effect.orDie,
		);

	const finish = (
		plan: ForkConstruction,
	): ReturnType<ConversationOperations["forkSession"]> =>
		Effect.gen(function* () {
			const rows = yield* load(plan.sessionId);
			const record = rows[0];
			if (record === undefined)
				return yield* Effect.die("Fork construction was not staged");
			if (record.cancelled_at !== null)
				return yield* new SessionStartError({
					providerId: plan.providerId,
					reason: "This fork was cancelled.",
				});
			const existing =
				yield* sql`SELECT id FROM sessions WHERE id=${plan.sessionId}`.pipe(
					Effect.orDie,
				);
			let session: Session;
			let chat: Chat;
			if (existing.length > 0 || record.completed_at !== null) {
				session = yield* options.lookupSession(plan.sessionId);
				chat = yield* options.lookupChat(plan.chatId).pipe(Effect.orDie);
			} else {
				const source =
					plan.forkedFromSessionId === null
						? []
						: yield* sql`SELECT id FROM sessions WHERE id=${plan.forkedFromSessionId}`.pipe(
								Effect.orDie,
							);
				const input = {
					...plan,
					forkedFromSessionId:
						source.length === 0 ? null : plan.forkedFromSessionId,
					background: true,
					forkFromResume: plan.forkMode === "resume",
				};

				const chats =
					yield* sql`SELECT id FROM chats WHERE id=${plan.chatId}`.pipe(
						Effect.orDie,
					);
				if (plan.destination === "tab" || chats.length > 0) {
					session = yield* options.createSession(input);
					chat = yield* options.lookupChat(plan.chatId).pipe(Effect.orDie);
				} else {
					const created = yield* options.createChat({
						...input,
						initialSessionId: plan.sessionId,
					});
					session = created.initialSession;
					chat = created.chat;
				}
			}
			if (record.completed_at !== null)
				return { chat, session, forkMode: plan.forkMode };
			for (const message of plan.messages) {
				yield* options.persistMessage(
					session.id,
					message.content,
					forkMessageId(session.id, message.id),
				);
			}

			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						if (plan.forkMode === "copy")
							yield* handoff.capture(
								session.id,
								plan.providerId,
								`fork:${session.id}`,
							);
						yield* sql`UPDATE session_fork_constructions SET completed_at=${Date.now()},error=NULL,payload_json=${JSON.stringify({ ...plan, messages: [] })} WHERE session_id=${session.id} AND completed_at IS NULL`;
					}),
				)
				.pipe(Effect.orDie);
			return { chat, session, forkMode: plan.forkMode };
		});

	const finishTracked = (plan: ForkConstruction) =>
		finish(plan).pipe(
			Effect.tapCause(() =>
				sql`UPDATE session_fork_constructions SET error='Fork creation did not finish. Retry or cancel this fork.' WHERE session_id=${plan.sessionId} AND completed_at IS NULL`.pipe(
					Effect.orDie,
					Effect.asVoid,
				),
			),
		);
	const ownedPlan = (sessionId: SessionId, forkSessionId: SessionId) =>
		Effect.gen(function* () {
			const rows = yield* load(forkSessionId);
			if (rows[0] === undefined)
				return yield* new SessionContextError({
					message: "Fork construction was not found.",
				});
			const plan = decode(JSON.parse(rows[0].payload_json));
			if (plan.sourceSessionId !== sessionId)
				return yield* new SessionContextError({
					message: "This fork belongs to another conversation.",
				});
			return { plan, record: rows[0] };
		});

	const stage = (plan: ForkConstruction) => {
		const work = Effect.gen(function* () {
			const rows = yield* load(plan.sessionId);
			if (rows[0] !== undefined) {
				const original = decode(JSON.parse(rows[0].payload_json));
				if (
					original.nativeChildStepId !== plan.nativeChildStepId ||
					original.commandId !== plan.commandId ||
					original.sourceSessionId !== plan.sourceSessionId ||
					original.providerId !== plan.providerId ||
					original.model !== plan.model ||
					original.chatId !== plan.chatId ||
					original.forkedFromSessionId !== plan.forkedFromSessionId ||
					original.forkedFromMessageId !== plan.forkedFromMessageId
				)
					return yield* Effect.die(
						"Fork identity conflicts with an existing construction",
					);
				return original;
			}
			if (plan.nativeChildStepId !== undefined) {
				const valid =
					yield* sql`SELECT id FROM session_execution_steps WHERE id=${plan.nativeChildStepId} AND session_id=${plan.sourceSessionId} AND kind='subagent' AND status='completed'`;
				if (valid.length === 0) return null;
			}
			const existing =
				yield* sql`SELECT id FROM sessions WHERE id=${plan.sessionId}`;
			if (existing.length > 0)
				return yield* Effect.die("Fork destination already exists");
			if (plan.destination === "chat") {
				const chats = yield* sql`SELECT id FROM chats WHERE id=${plan.chatId}`;
				if (chats.length > 0)
					return yield* Effect.die("Fork chat destination already exists");
			}
			yield* sql`INSERT INTO session_fork_constructions(session_id,payload_json,created_at) VALUES (${plan.sessionId},${JSON.stringify(plan)},${Date.now()})`;
			return plan;
		}).pipe(Effect.orDie);
		const admitted =
			options.admitConstruction === undefined
				? sql.withTransaction(work).pipe(Effect.orDie)
				: options.admitConstruction(work);
		return admitted.pipe(
			Effect.flatMap((frozen) =>
				frozen === null
					? Effect.fail(
							new SessionStartError({
								providerId: plan.providerId,
								reason:
									"The native child changed before its fork snapshot could be admitted.",
							}),
						)
					: Effect.succeed(frozen),
			),
		);
	};
	return {
		list: (sessionId: SessionId) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					session_id: string;
					payload_json: string;
					error: string | null;
					created_at: number;
				}>`SELECT session_id,payload_json,error,created_at FROM session_fork_constructions WHERE completed_at IS NULL AND json_extract(payload_json,'$.sourceSessionId')=${sessionId} ORDER BY created_at`;
				return rows.map(
					(row): SessionForkConstruction => ({
						sessionId: SessionId.make(row.session_id),
						title: decode(JSON.parse(row.payload_json)).title,
						state: row.error === null ? "pending" : "failed",
						error: row.error,
						createdAt: row.created_at,
					}),
				);
			}).pipe(
				Effect.catchCause(() =>
					Effect.fail(
						new SessionContextError({ message: "Could not read fork status." }),
					),
				),
			),
		retry: (sessionId: SessionId, forkSessionId: SessionId) =>
			Semaphore.withPermits(
				lock,
				1,
				Effect.gen(function* () {
					const { plan } = yield* ownedPlan(sessionId, forkSessionId);
					yield* finishTracked(plan);
				}),
			).pipe(
				Effect.catchCause(() =>
					Effect.fail(
						new SessionContextError({
							message: "The fork could not be completed. Retry or cancel it.",
						}),
					),
				),
			),
		cancel: (sessionId: SessionId, forkSessionId: SessionId) =>
			Semaphore.withPermits(
				lock,
				1,
				Effect.gen(function* () {
					const { record } = yield* ownedPlan(sessionId, forkSessionId);
					if (record.cancelled_at !== null) return;
					if (record.completed_at !== null)
						return yield* new SessionContextError({
							message: "This fork has already completed.",
						});
					const existing =
						yield* sql`SELECT id FROM sessions WHERE id=${forkSessionId}`;
					const cancel =
						sql`UPDATE session_fork_constructions SET completed_at=${Date.now()},cancelled_at=${Date.now()},error=NULL,payload_json=json_set(payload_json,'$.messages',json('[]')) WHERE session_id=${forkSessionId} AND completed_at IS NULL`.pipe(
							Effect.asVoid,
						);
					if (existing.length === 0) yield* sql.withTransaction(cancel);
					else {
						if (options.sessionDomain === undefined)
							return yield* new SessionContextError({
								message: "Fork cancellation is unavailable.",
							});
						yield* options.sessionDomain.dispatchTransactionally(
							{
								commandId: `cancel-fork:${forkSessionId}`,
								streamId: forkSessionId,
								command: { _tag: "DeleteSession", deletedAt: Date.now() },
							},
							() => cancel,
						);
					}
				}),
			).pipe(
				Effect.catchCause(() =>
					Effect.fail(
						new SessionContextError({
							message: "The fork could not be cancelled.",
						}),
					),
				),
			),
		resume: (sessionId: SessionId, input: ForkSessionInput) =>
			Semaphore.withPermits(
				lock,
				1,
				Effect.gen(function* () {
					const rows = yield* load(sessionId);
					if (rows[0] === undefined) return null;
					const plan = decode(JSON.parse(rows[0].payload_json));
					if (
						plan.nativeChildStepId !== input.nativeChildStepId ||
						plan.commandId !== input.commandId ||
						plan.sourceSessionId !== input.sourceSessionId ||
						plan.forkedFromMessageId !== input.fromMessageId ||
						plan.destination !== input.destination ||
						(input.providerId !== undefined &&
							plan.providerId !== input.providerId) ||
						(input.model !== undefined && plan.model !== input.model) ||
						(input.chatId !== undefined && plan.chatId !== input.chatId) ||
						(input.title?.trim() && plan.title !== input.title.trim()) ||
						(input.worktreeId !== undefined &&
							plan.worktreeId !== input.worktreeId)
					)
						return yield* Effect.die(
							"Fork command conflicts with its durable construction",
						);
					return yield* finishTracked(plan);
				}),
			),
		construct: (plan: ForkConstruction) =>
			Semaphore.withPermits(
				lock,
				1,
				Effect.gen(function* () {
					const frozen = yield* stage(plan);
					return yield* finishTracked(frozen);
				}),
			),
		recover: () =>
			Semaphore.withPermits(
				lock,
				1,
				Effect.gen(function* () {
					const rows = yield* sql<{
						payload_json: string;
					}>`SELECT payload_json FROM session_fork_constructions WHERE completed_at IS NULL ORDER BY created_at ASC`.pipe(
						Effect.orDie,
					);
					for (const row of rows)
						yield* Effect.suspend(() =>
							finishTracked(decode(JSON.parse(row.payload_json))),
						).pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning("Fork construction recovery failed", cause),
							),
						);
				}),
			),
	};
};
