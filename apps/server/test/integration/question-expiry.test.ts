import { SessionId } from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { projectSessionInput } from "@zuse/domain/projectors/sql-input-projector";
import { readSessionTimelineSnapshot } from "@zuse/domain/queries/session-timeline-snapshot";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { makeQuestionExpiry } from "../../src/conversation/core/question-expiry.ts";
import { Migration0071QuestionExpiry } from "../../src/persistence/migrations/0071_question_expiry.ts";

test.each([
	"live",
	"detached",
	"replaced",
	"restored",
	"answered",
	"legacy",
] as const)("question expiry handles %s authority", async (mode) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				const sessionId = SessionId.make("session-1");
				const dispatch = (
					command: Parameters<typeof domain.dispatch>[0]["command"],
				) =>
					domain.dispatch({
						streamId: sessionId,
						commandId: crypto.randomUUID(),
						command,
					});
				yield* dispatch(createSessionCommand);
				yield* sql`UPDATE sessions SET provider_reservation_id = 'provider-1' WHERE id = ${sessionId}`;
				yield* dispatch({
					_tag: "PersistMessage",
					messageId: "question-message",
					turnId: null,
					role: "assistant",
					kind: "user_question",
					parentItemId: null,
					createdAt: 1,
					...(mode === "legacy"
						? {}
						: { inputOwner: { providerSessionId: "provider-1" } }),
					contentJson: JSON.stringify({
						_tag: "user_question",
						itemId: "question",
						questions: [{ question: "Continue?", options: ["Yes"] }],
					}),
				});
				if (mode === "replaced")
					yield* sql`UPDATE sessions SET provider_reservation_id = 'provider-2' WHERE id = ${sessionId}`;
				if (mode === "answered")
					yield* dispatch({
						_tag: "ResolveQuestion",
						itemId: "question",
						resolution: "cancelled",
						resolvedAt: 2,
					});
				let checks = 0;
				const cancelled: string[] = [];
				const acknowledged: string[] = [];
				const sweep = makeQuestionExpiry(sql, domain, {
					hasQuestionAttachment: () =>
						Effect.sync(() => {
							checks++;
							return mode === "restored" ? checks > 1 : mode !== "detached";
						}),
					cancelQuestion: (_, id) =>
						Effect.sync(() => {
							cancelled.push(id);
						}),
					acknowledgeQuestionResolution: (_, id) =>
						Effect.sync(() => {
							acknowledged.push(id);
						}),
					close: () => Effect.die("Unexpected provider close"),
				});
				yield* sweep;
				const expired = ["detached", "replaced", "legacy"].includes(mode);
				expect(
					yield* sql`SELECT status, awaiting_dismissal FROM session_inputs`,
				).toEqual([
					{
						status: expired
							? "expired"
							: mode === "answered"
								? "cancelled"
								: "pending",
						awaiting_dismissal: expired ? 1 : 0,
					},
				]);
				expect(cancelled).toEqual(
					expired && mode !== "detached" ? ["question"] : [],
				);
				expect(acknowledged).toEqual(expired ? ["question"] : []);
				const snapshot = yield* readSessionTimelineSnapshot(sql, sessionId);
				expect(snapshot.projection.interactions).toEqual(
					mode === "answered"
						? []
						: [
								expect.objectContaining(
									expired ? { recoveryState: "expired" } : { id: "question" },
								),
							],
				);
				if (expired) {
					yield* dispatch({
						_tag: "ResolveQuestion",
						itemId: "question",
						resolution: "cancelled",
						resolvedAt: 3,
					});
					expect(
						(yield* readSessionTimelineSnapshot(sql, sessionId)).projection
							.interactions,
					).toEqual([]);
				}
				yield* sweep;
				expect(acknowledged).toHaveLength(expired ? 1 : 0);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test("question expiry schema upgrades existing input projections idempotently", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TABLE sessions (id TEXT PRIMARY KEY)`;
			yield* sql`CREATE TABLE session_inputs (session_id TEXT, kind TEXT, request_id TEXT, status TEXT, request_json TEXT, requested_sequence INTEGER)`;
			yield* sql`INSERT INTO session_inputs VALUES ('session', 'question', 'question', 'pending', '{}', 1)`;
			yield* Migration0071QuestionExpiry;
			yield* Migration0071QuestionExpiry;
			expect(yield* sql`SELECT awaiting_dismissal FROM session_inputs`).toEqual(
				[{ awaiting_dismissal: 0 }],
			);
		}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test("live questions cannot starve a detached question beyond the first sweep page", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "create",
					command: createSessionCommand,
				});
				yield* sql`UPDATE sessions SET provider_reservation_id = 'provider-1' WHERE id = 'session-1'`;
				for (let i = 0; i < 101; i++) {
					const id = `question-${String(i).padStart(3, "0")}`;
					yield* domain.dispatch({
						streamId: "session-1",
						commandId: id,
						command: {
							_tag: "PersistMessage",
							messageId: id,
							turnId: null,
							role: "assistant",
							kind: "user_question",
							parentItemId: null,
							createdAt: 1,
							inputOwner: { providerSessionId: "provider-1" },
							contentJson: JSON.stringify({
								_tag: "user_question",
								itemId: id,
								questions: [{ question: "Continue?", options: ["Yes"] }],
							}),
						},
					});
				}
				const acknowledged: string[] = [];
				const sweep = makeQuestionExpiry(sql, domain, {
					hasQuestionAttachment: (_, id) =>
						Effect.succeed(id !== "question-100"),
					cancelQuestion: () => Effect.die("Cannot cancel a detached callback"),
					acknowledgeQuestionResolution: (_, id) =>
						Effect.sync(() => {
							acknowledged.push(id);
						}),
					close: () => Effect.die("Unexpected close"),
				});
				yield* sweep;
				expect(acknowledged).toEqual([]);
				yield* sweep;
				expect(acknowledged).toEqual(["question-100"]);
				yield* sweep;
				expect(acknowledged).toEqual(["question-100"]);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test("legacy imported requests expire even when no question event exists in the aggregate", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "create",
					command: createSessionCommand,
				});
				const content = JSON.stringify({
					_tag: "user_question",
					itemId: "imported",
					questions: [{ question: "Continue?", options: ["Yes"] }],
				});
				yield* sql`INSERT INTO session_inputs (session_id,kind,request_id,status,request_json,requested_at,requested_sequence,updated_sequence) VALUES ('session-1','question','imported','pending',${content},'2026-01-01T00:00:00.000Z',0,0)`;
				yield* makeQuestionExpiry(sql, domain, {
					hasQuestionAttachment: () => Effect.succeed(false),
					cancelQuestion: () => Effect.die("No callback to cancel"),
					acknowledgeQuestionResolution: () => Effect.void,
					close: () => Effect.die("No provider to close"),
				});
				expect(
					yield* sql`SELECT status,awaiting_dismissal FROM session_inputs`,
				).toEqual([{ status: "expired", awaiting_dismissal: 1 }]);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});

test("replaying an older expiry cannot restore dismissal after a native timeout", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(crypto.randomUUID()),
				);
				yield* domain.dispatch({
					streamId: "session-1",
					commandId: "create",
					command: createSessionCommand,
				});
				const expiry = {
					streamId: "session-1",
					sequence: 2,
					event: {
						_tag: "QuestionExpired" as const,
						itemId: "question",
						expiredAt: 2,
					},
				};
				yield* projectSessionInput(sql, expiry);
				yield* projectSessionInput(sql, {
					streamId: "session-1",
					sequence: 3,
					event: {
						_tag: "MessagePersisted",
						messageId: "answer",
						turnId: null,
						role: "user",
						kind: "user_question_answer",
						contentJson: JSON.stringify({
							_tag: "user_question_answer",
							itemId: "question",
							answers: [],
							resolution: "timed-out",
						}),
						parentItemId: null,
						createdAt: 3,
					},
				});
				yield* projectSessionInput(sql, expiry);
				expect(
					yield* sql`SELECT status, awaiting_dismissal, updated_sequence FROM session_inputs`,
				).toEqual([
					{ status: "expired", awaiting_dismissal: 0, updated_sequence: 3 },
				]);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
