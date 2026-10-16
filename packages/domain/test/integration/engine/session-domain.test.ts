import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	PubSub,
	type Scope,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import type { SessionCommand } from "../../../src/core/commands.js";
import { attemptIdFor } from "../../../src/core/state.js";
import {
	makeSessionDomain,
	SessionDomain,
} from "../../../src/engine/session-domain.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

const run = <A, E>(
	program: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
	Effect.runPromise(
		Effect.scoped(
			program.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
		),
	);

const makeDomainRuntime = (filename: string, eventPrefix: string) => {
	const sqlite = sqliteLayer({ filename });
	let nextEventId = 0;
	const domain = Layer.effect(
		SessionDomain,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* makeSessionDomain(sql, () =>
				Effect.succeed(`${eventPrefix}-${++nextEventId}`),
			);
		}),
	).pipe(Layer.provideMerge(sqlite));
	return ManagedRuntime.make(domain);
};

describe("SessionDomain", () => {
	test("projects reservation ownership through replacement, configuration changes and deletion", async () => {
		await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`projection-${++sequence}`),
				);
				const reserve = (id: string): SessionCommand => ({
					_tag: "ReserveProviderSession",
					providerId: "provider-1",
					providerSessionId: id,
					reservedAt: 2,
				});
				const transitions: ReadonlyArray<
					readonly [SessionCommand, string | null]
				> = [
					[createSessionCommand, null],
					[reserve("first"), "first"],
					[
						{
							_tag: "AttachProvider",
							providerId: "provider-1",
							providerSessionId: "first",
							attachedAt: 3,
						},
						"first",
					],
					[reserve("second"), "second"],
					[
						{
							_tag: "DetachProvider",
							expectedProviderSessionId: "first",
							detachedAt: 4,
						},
						"second",
					],
					[{ _tag: "SetWorktree", worktreeId: null, updatedAt: 5 }, "second"],
					[{ _tag: "SetWorktree", worktreeId: "worktree", updatedAt: 6 }, null],
					[reserve("worktree"), "worktree"],
					[{ _tag: "SetModel", model: "model-2", updatedAt: 7 }, null],
					[reserve("model"), "model"],
					[{ _tag: "ArchiveSession", archivedAt: 8 }, null],
					[{ _tag: "UnarchiveSession", unarchivedAt: 9 }, null],
					[reserve("stopping"), "stopping"],
					[{ _tag: "RequestProviderStop", requestedAt: 10 }, null],
					[reserve("deleting"), "deleting"],
					[{ _tag: "DeleteSession", deletedAt: 11 }, null],
				];
				for (const [index, [command, expected]] of transitions.entries()) {
					yield* domain.dispatch({
						commandId: `command-${index}`,
						streamId: "session-1",
						command,
					});
					expect(
						yield* domain.providerReservation("session-1"),
						command._tag,
					).toBe(expected);
				}
				const restarted = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`reloaded-${++sequence}`),
				);
				expect(yield* restarted.providerReservation("session-1")).toBeNull();
			}),
		);
	});

	test("a durable stop revokes unpublished startup and guarded receipt replay", async () => {
		await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const make = () =>
					makeSessionDomain(sql, () =>
						Effect.succeed(`reservation-${++sequence}`),
					);
				const domain = yield* make();
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "reserve",
					streamId: "session-1",
					command: {
						_tag: "ReserveProviderSession",
						providerId: "provider-1",
						providerSessionId: "starting",
						reservedAt: 2,
					},
				});
				const publication = {
					commandId: "publish-status",
					streamId: "session-1",
					expectedProviderSessionId: "starting",
					command: {
						_tag: "SetStatus" as const,
						status: "booting" as const,
						updatedAt: 3,
					},
				};
				yield* domain.dispatch(publication);
				yield* domain.dispatch({
					commandId: "stop",
					streamId: "session-1",
					command: { _tag: "RequestProviderStop", requestedAt: 4 },
				});
				expect(
					(yield* domain.jobs.listBySession("session-1")).map(
						(job) => job.request,
					),
				).toEqual([
					{
						_tag: "provider.stop",
						providerSessionId: "starting",
						requestedAt: 4,
					},
				]);
				const restarted = yield* make();
				expect(yield* restarted.providerReservation("session-1")).toBeNull();
				for (const input of [
					publication,
					{
						commandId: "late-attach",
						streamId: "session-1",
						expectedProviderSessionId: "starting",
						command: {
							_tag: "AttachProvider" as const,
							providerId: "provider-1",
							providerSessionId: "starting",
							attachedAt: 5,
						},
					},
				]) {
					let callback = false;
					const result = yield* restarted
						.dispatchTransactionally(input, () =>
							Effect.sync(() => {
								callback = true;
							}),
						)
						.pipe(Effect.result);
					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure")
						expect(result.failure._tag).toBe(
							"ProviderSessionOwnershipConflict",
						);
					expect(callback).toBe(false);
				}
			}),
		);
	});

	test("retiring the old attachment preserves a replacement startup reservation", async () => {
		await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`replacement-${++sequence}`),
				);
				const dispatch = (commandId: string, command: SessionCommand) =>
					domain.dispatch({ commandId, streamId: "session-1", command });
				yield* dispatch("create", createSessionCommand);
				yield* dispatch("old-attach", {
					_tag: "AttachProvider",
					providerId: "provider-1",
					providerSessionId: "old",
					attachedAt: 2,
				});
				yield* dispatch("reserve", {
					_tag: "ReserveProviderSession",
					providerId: "provider-1",
					providerSessionId: "replacement",
					reservedAt: 3,
				});
				yield* dispatch("old-detach", {
					_tag: "DetachProvider",
					expectedProviderSessionId: "old",
					detachedAt: 4,
				});
				yield* domain.dispatch({
					commandId: "new-attach",
					streamId: "session-1",
					expectedProviderSessionId: "replacement",
					command: {
						_tag: "AttachProvider",
						providerId: "provider-1",
						providerSessionId: "replacement",
						attachedAt: 5,
					},
				});
				yield* dispatch("stop-new", {
					_tag: "RequestProviderStop",
					requestedAt: 6,
				});
				expect(
					(yield* domain.jobs.listBySession("session-1")).map(
						(job) => job.request,
					),
				).toEqual([
					{ _tag: "provider.stop", providerSessionId: "old", requestedAt: 3 },
					{
						_tag: "provider.stop",
						providerSessionId: "replacement",
						requestedAt: 6,
					},
				]);
			}),
		);
	});

	test("replays stop residency and fences detachment after provider replacement", async () => {
		await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const make = () =>
					makeSessionDomain(sql, () =>
						Effect.succeed(`residency-${++sequence}`),
					);
				const domain = yield* make();
				const dispatch = (commandId: string, command: SessionCommand) =>
					domain.dispatch({ commandId, streamId: "session-1", command });
				yield* dispatch("create", createSessionCommand);
				yield* dispatch("attach-first", {
					_tag: "AttachProvider",
					providerId: "claude",
					providerSessionId: "first",
					attachedAt: 1,
				});
				yield* dispatch("stop-first", {
					_tag: "RequestProviderStop",
					requestedAt: 2,
				});
				yield* dispatch("attach-second", {
					_tag: "AttachProvider",
					providerId: "claude",
					providerSessionId: "second",
					attachedAt: 3,
				});
				const restarted = yield* make();
				const jobs = yield* restarted.jobs.listBySession("session-1");
				expect(jobs.map((job) => job.request)).toEqual([
					{ _tag: "provider.stop", providerSessionId: "first", requestedAt: 2 },
				]);
				const version = yield* restarted.currentStreamVersion("session-1");
				for (const target of ["first", null]) {
					const receipt = yield* restarted.dispatch({
						commandId: `late-${target}`,
						streamId: "session-1",
						command: {
							_tag: "DetachProvider",
							expectedProviderSessionId: target,
							detachedAt: 4,
						},
					});
					expect(receipt.eventIds).toEqual([]);
					expect(yield* restarted.currentStreamVersion("session-1")).toBe(
						version,
					);
				}
				const receipt = yield* restarted.dispatch({
					commandId: "detach-second",
					streamId: "session-1",
					command: {
						_tag: "DetachProvider",
						expectedProviderSessionId: "second",
						detachedAt: 5,
					},
				});
				expect(receipt.eventIds).toHaveLength(1);
			}),
		);
	});

	test("fences late attempt writes and transactional callbacks after retry and restart", async () => {
		await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const make = () =>
					makeSessionDomain(sql, () => Effect.succeed(`fenced-${++sequence}`));
				const domain = yield* make();
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "start",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 2 },
				});
				const first = {
					turnId: "turn-1",
					attemptId: attemptIdFor("turn-1", 1),
				};
				const status = {
					commandId: "status-before-retry",
					streamId: "session-1",
					expectedAttempt: first,
					command: {
						_tag: "SetStatus" as const,
						status: "running" as const,
						updatedAt: 3,
					},
				};
				yield* domain.dispatch(status);
				yield* domain.dispatch({
					commandId: "interrupt",
					streamId: "session-1",
					command: { _tag: "RequestTurnInterrupt", requestedAt: 4 },
				});
				yield* domain.dispatch({
					commandId: "retry",
					streamId: "session-1",
					command: {
						_tag: "RetryTurn",
						turnId: "turn-1",
						reason: "retry",
						requestedAt: 5,
						providerInputJson: "{}",
					},
				});
				const jobs = yield* domain.jobs.listBySession("session-1");
				expect(
					jobs.map((job) => [
						job.request._tag,
						job.status,
						"attemptId" in job.request ? job.request.attemptId : null,
					]),
				).toEqual([
					["provider.turn.interrupt", "cancelled", first.attemptId],
					["provider.turn.send", "pending", attemptIdFor("turn-1", 2)],
				]);
				const restarted = yield* make();
				const version = yield* restarted.currentStreamVersion("session-1");
				const lateCommands: SessionCommand[] = [
					{
						_tag: "SettleTurn",
						turnId: "turn-1",
						outcome: "completed",
						settledAt: 6,
					},
					{ _tag: "BindProviderThread", nativeThreadId: "stale", updatedAt: 6 },
					{ _tag: "SetStatus", status: "error", updatedAt: 6 },
					{
						_tag: "PersistMessage",
						messageId: "stale-message",
						turnId: "turn-1",
						role: "assistant",
						kind: "text",
						contentJson: "{}",
						parentItemId: null,
						createdAt: 6,
					},
				];
				let callbacks = 0;
				for (const [index, command] of lateCommands.entries()) {
					const result = yield* restarted
						.dispatchTransactionally(
							{
								commandId: `late-${index}`,
								streamId: "session-1",
								expectedAttempt: first,
								command,
							},
							() =>
								Effect.sync(() => {
									callbacks++;
								}),
						)
						.pipe(Effect.result);
					expect(result).toMatchObject({
						_tag: "Failure",
						failure: {
							_tag: "AttemptOwnershipConflict",
							expectedAttemptId: first.attemptId,
							actualAttemptId: attemptIdFor("turn-1", 2),
						},
					});
				}
				const replay = yield* restarted
					.dispatchTransactionally(status, () =>
						Effect.sync(() => {
							callbacks++;
						}),
					)
					.pipe(Effect.result);
				expect(replay).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "AttemptOwnershipConflict" },
				});
				expect(callbacks).toBe(0);
				expect(yield* restarted.currentStreamVersion("session-1")).toBe(
					version,
				);
				yield* restarted.dispatch({
					commandId: "settle-current",
					streamId: "session-1",
					expectedAttempt: {
						turnId: "turn-1",
						attemptId: attemptIdFor("turn-1", 2),
					},
					command: {
						_tag: "SettleTurn",
						turnId: "turn-1",
						outcome: "completed",
						settledAt: 7,
					},
				});
				const turns =
					yield* sql`SELECT status, active_attempt_id FROM session_turns WHERE session_id = 'session-1'`;
				expect(turns).toEqual([
					{ status: "completed", active_attempt_id: attemptIdFor("turn-1", 2) },
				]);
				const tail = {
					commandId: "final-cursor",
					streamId: "session-1",
					expectedAttempt: {
						turnId: "turn-1",
						attemptId: attemptIdFor("turn-1", 2),
					},
					command: {
						_tag: "BindProviderThread" as const,
						nativeThreadId: "thread-final",
						nativeHeadId: "head-final",
						updatedAt: 8,
					},
				};
				yield* restarted.dispatch(tail);
				yield* restarted.dispatch({
					commandId: "next-turn",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-2", startedAt: 9 },
				});
				const obsoleteTail = yield* restarted
					.dispatch({ ...tail, commandId: "late-cursor" })
					.pipe(Effect.result);
				expect(obsoleteTail).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "AttemptOwnershipConflict" },
				});
			}),
		);
	});

	test("forks sharing a native thread keep independent heads and survive sibling deletion", async () => {
		await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let event = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`ownership-${++event}`),
				);
				for (const sessionId of ["parent", "fork"]) {
					yield* domain.dispatch({
						commandId: `create-${sessionId}`,
						streamId: sessionId,
						command: {
							...createSessionCommand,
							sessionId,
							providerId: "codex",
							providerThread: {
								provider: "codex",
								nativeThreadId: "shared-native",
								nativeHeadId: `${sessionId}-head`,
							},
						},
					});
				}
				const before = yield* sql<{
					id: string;
					session_id: string;
					native_head_id: string;
				}>`SELECT id, session_id, native_head_id FROM session_provider_threads ORDER BY session_id`;
				expect(new Set(before.map((row) => row.id)).size).toBe(2);
				expect(
					before.map((row) => [row.session_id, row.native_head_id]),
				).toEqual([
					["fork", "fork-head"],
					["parent", "parent-head"],
				]);
				yield* domain.dispatch({
					commandId: "advance-fork",
					streamId: "fork",
					command: {
						_tag: "BindProviderThread",
						nativeThreadId: "shared-native",
						nativeHeadId: "fork-new",
						updatedAt: 2,
					},
				});
				yield* domain.dispatch({
					commandId: "delete-fork",
					streamId: "fork",
					command: { _tag: "DeleteSession", deletedAt: 3 },
				});
				const remaining = yield* sql<{
					session_id: string;
					native_head_id: string;
				}>`SELECT session_id, native_head_id FROM session_provider_threads`;
				expect(remaining).toEqual([
					{ session_id: "parent", native_head_id: "parent-head" },
				]);
				const replayed = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`replayed-${++event}`),
				);
				yield* replayed.dispatch({
					commandId: "advance-parent",
					streamId: "parent",
					command: {
						_tag: "BindProviderThread",
						nativeThreadId: "shared-native",
						nativeHeadId: "parent-new",
						updatedAt: 4,
					},
				});
				expect(
					yield* sql`SELECT native_head_id FROM session_provider_threads WHERE session_id = 'parent'`,
				).toEqual([{ native_head_id: "parent-new" }]);
			}),
		);
	});

	test("publishes retry cancellation only after the replacement attempt commits", async () => {
		await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				let sequence = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`retry-event-${++sequence}`),
				);
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "start",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 2 },
				});
				const retry = {
					streamId: "session-1",
					command: {
						_tag: "RetryTurn" as const,
						turnId: "turn-1",
						reason: "retry" as const,
						providerInputJson: "{}",
						requestedAt: 3,
					},
				};
				yield* domain.dispatch({ ...retry, commandId: "first-send" });
				const claimed = yield* domain.jobs.claimNext({
					workerId: "old",
					leaseMs: 30000,
				});
				expect(claimed).not.toBeNull();
				if (claimed === null) return;
				const notifications = yield* PubSub.subscribe(domain.jobCancellations);
				const aborted = yield* domain
					.dispatchTransactionally(
						{ ...retry, commandId: "aborted-retry" },
						() => Effect.die("rollback retry"),
					)
					.pipe(Effect.exit);
				expect(aborted._tag).toBe("Failure");
				expect((yield* domain.jobs.get(claimed.id))?.status).toBe("running");
				yield* domain.dispatch({ ...retry, commandId: "committed-retry" });
				const cancelled = yield* PubSub.take(notifications);
				expect(cancelled).toEqual([claimed.id]);
				expect((yield* domain.jobs.get(claimed.id))?.status).toBe("cancelled");
				expect(
					(yield* domain.jobs.listBySession("session-1")).map(
						(job) => job.status,
					),
				).toEqual(["cancelled", "pending"]);
			}),
		);
	});

	test("rolls back events and receipts when projection fails", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					CREATE TRIGGER fail_session_projection
					BEFORE INSERT ON sessions
					BEGIN
						SELECT RAISE(ABORT, 'projection failed');
					END
				`;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed("event-rollback"),
				);
				yield* domain
					.dispatch({
						commandId: "command-rollback",
						streamId: "session-1",
						command: createSessionCommand,
					})
					.pipe(Effect.flip);
				const events = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events
				`;
				const receipts = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM command_receipts
				`;
				return {
					events: events[0]?.count ?? -1,
					receipts: receipts[0]?.count ?? -1,
				};
			}),
		);

		expect(result).toEqual({ events: 0, receipts: 0 });
	});

	test("rolls back events, projection, and receipt when a transactional callback fails", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed("event-callback-rollback"),
				);
				yield* domain
					.dispatchTransactionally(
						{
							commandId: "command-callback-rollback",
							streamId: "session-1",
							command: createSessionCommand,
						},
						() => Effect.fail("creation receipt failed" as const),
					)
					.pipe(Effect.flip);
				const events = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events
				`;
				const receipts = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM command_receipts
				`;
				const sessions = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM sessions
				`;
				return {
					events: events[0]?.count ?? -1,
					receipts: receipts[0]?.count ?? -1,
					sessions: sessions[0]?.count ?? -1,
				};
			}),
		);

		expect(result).toEqual({ events: 0, receipts: 0, sessions: 0 });
	});

	test("dispatches, projects, and replays a durable receipt", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				const first = yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const restarted = yield* makeSessionDomain(sql, () =>
					Effect.succeed("unexpected-event"),
				);
				const replay = yield* restarted.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const sessions = yield* sql<{ readonly id: string }>`
					SELECT id FROM sessions
				`;
				const events = yield* sql<{ readonly event_id: string }>`
					SELECT event_id FROM events
				`;
				const cursor = yield* sql<{ readonly last_sequence: number }>`
					SELECT last_sequence FROM projector_cursors
					WHERE projector_name = 'session-read-model'
				`;
				return { first, replay, sessions, events, cursor };
			}),
		);

		expect(result.replay).toEqual(result.first);
		expect(result.sessions).toEqual([{ id: "session-1" }]);
		expect(result.events).toEqual([{ event_id: "event-1" }]);
		expect(result.cursor).toEqual([{ last_sequence: 1 }]);
	});

	test("projects the bound provider thread transactionally with the session", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`resume-event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "create-for-resume",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "bind-provider-thread",
					streamId: "session-1",
					command: {
						_tag: "BindProviderThread",
						nativeThreadId: "provider-session",
						nativeHeadId: "provider-event-7",
						updatedAt: 2,
					},
				});
				const threads = yield* sql<{
					readonly id: string;
					readonly native_thread_id: string;
					readonly native_head_id: string | null;
					readonly status: string;
				}>`
					SELECT id, native_thread_id, native_head_id, status
					FROM session_provider_threads WHERE session_id = 'session-1'
				`;
				const active = yield* sql<{
					readonly active_provider_thread_id: string | null;
				}>`
					SELECT active_provider_thread_id FROM sessions WHERE id = 'session-1'
				`;
				return { threads, active };
			}),
		);

		expect(result.threads).toEqual([
			{
				id: "provider-thread:session:session-1:provider-thread%3Aprovider%3Aprovider-1%3Anative-thread%3Aprovider-session",
				native_thread_id: "provider-session",
				native_head_id: "provider-event-7",
				status: "idle",
			},
		]);
		expect(result.active).toEqual([
			{
				active_provider_thread_id:
					"provider-thread:session:session-1:provider-thread%3Aprovider%3Aprovider-1%3Anative-thread%3Aprovider-session",
			},
		]);
	});

	test("rebuilds checkpoint high-water and rejects stale content after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-checkpoint-"));
		const filename = join(directory, "checkpoint.sqlite");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* createDomainTestSchema();
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO chats (id, updated_at)
						VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
					`;
				}).pipe(Effect.provide(sqliteLayer({ filename }))),
			),
		);

		const firstRuntime = makeDomainRuntime(filename, "first-checkpoint");
		const secondRuntime = makeDomainRuntime(filename, "second-checkpoint");
		try {
			await firstRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						yield* domain.dispatch({
							commandId: "create",
							streamId: "session-1",
							command: createSessionCommand,
						});
						yield* domain.dispatch({
							commandId: "checkpoint-2",
							streamId: "session-1",
							command: {
								_tag: "PersistMessage",
								messageId: "provider-message-1",
								turnId: "turn-1",
								role: "assistant",
								kind: "assistant",
								contentJson: '{"_tag":"assistant","text":"winner"}',
								parentItemId: null,
								checkpointRevision: 2,
								checkpointFinal: false,
								createdAt: 2,
							},
						});
					}),
				),
			);
			const result = await secondRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						const stale = yield* domain.dispatch({
							commandId: "checkpoint-1-late",
							streamId: "session-1",
							command: {
								_tag: "PersistMessage",
								messageId: "provider-message-1",
								turnId: "turn-1",
								role: "assistant",
								kind: "assistant",
								contentJson: '{"_tag":"assistant","text":"stale"}',
								parentItemId: null,
								checkpointRevision: 1,
								checkpointFinal: false,
								createdAt: 3,
							},
						});
						const sql = yield* SqlClient.SqlClient;
						const messages = yield* sql<{
							readonly content_json: string;
							readonly checkpoint_revision: number;
						}>`
							SELECT content_json, checkpoint_revision FROM messages
							WHERE id = 'provider-message-1'
						`;
						return { stale, messages };
					}),
				),
			);
			expect(result.stale.eventIds).toEqual([]);
			expect(result.messages).toEqual([
				{
					content_json: '{"_tag":"assistant","text":"winner"}',
					checkpoint_revision: 2,
				},
			]);
		} finally {
			await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()]);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("replays then tails one ordered stream without duplicate receipts", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const replay = yield* domain
					.events({ streamId: "session-1" })
					.pipe(Stream.take(1), Stream.runCollect);
				const liveFiber = yield* domain
					.events({ streamId: "session-1", afterSequence: 1 })
					.pipe(
						Stream.take(1),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: { _tag: "SetTitle", title: "Renamed", updatedAt: 2 },
				});
				const live = yield* Fiber.join(liveFiber);
				return { replay: [...replay], live: [...live] };
			}),
		);

		expect(result.replay.map(({ sequence }) => sequence)).toEqual([1]);
		expect(result.live.map(({ sequence }) => sequence)).toEqual([2]);
		expect(result.live[0]?.event._tag).toBe("SessionTitleSet");
	});

	test("replays and tails all session streams with one global cursor", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z'),
					       ('chat-2', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create-1",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const cursor = yield* domain.currentSequence;
				const liveFiber = yield* domain
					.allEvents({ afterSequence: cursor })
					.pipe(
						Stream.take(1),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* domain.dispatch({
					commandId: "command-create-2",
					streamId: "session-2",
					command: {
						...createSessionCommand,
						sessionId: "session-2",
						chatId: "chat-2",
					},
				});
				const live = yield* Fiber.join(liveFiber);
				return { cursor, live: [...live] };
			}),
		);

		expect(result.cursor).toBe(1);
		expect(result.live.map((event) => event.streamId)).toEqual(["session-2"]);
		expect(result.live.map((event) => event.sequence)).toEqual([2]);
	});

	test("publishes live events only after the session projection is current", async () => {
		const observedStatus = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const cursor = yield* domain.currentSequence;
				const observed = yield* domain
					.allEvents({ afterSequence: cursor })
					.pipe(
						Stream.take(1),
						Stream.mapEffect(() =>
							sql<{ readonly status: string }>`
								SELECT status FROM sessions WHERE id = 'session-1'
							`.pipe(Effect.map((rows) => rows[0]?.status ?? "missing")),
						),
						Stream.runHead,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* domain.dispatch({
					commandId: "command-running",
					streamId: "session-1",
					command: { _tag: "SetStatus", status: "running", updatedAt: 2 },
				});
				return yield* Fiber.join(observed);
			}),
		);

		expect(observedStatus).toMatchObject({
			_tag: "Some",
			value: "running",
		});
	});

	test("attaches live delivery before snapshot and emits a versioned barrier", async () => {
		const frames = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const collecting = yield* domain
					.synchronizedEvents({
						streamId: "session-1",
						hasProjection: false,
					})
					.pipe(
						Stream.take(3),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* Effect.yieldNow;
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: { _tag: "SetTitle", title: "Renamed", updatedAt: 2 },
				});
				return [...(yield* Fiber.join(collecting))];
			}),
		);
		expect(frames[0]).toMatchObject({ kind: "snapshot", throughVersion: 1 });
		expect(frames[1]).toMatchObject({
			kind: "synchronized",
			streamEpoch: "legacy",
			throughVersion: 1,
		});
		expect(frames[2]).toMatchObject({
			kind: "event",
			record: { streamVersion: 2 },
		});
		expect(
			frames
				.flatMap((frame) =>
					frame.kind === "snapshot"
						? [frame.throughVersion]
						: frame.kind === "event"
							? [frame.record.streamVersion]
							: [],
				)
				.sort((left, right) => left - right),
		).toEqual([1, 2]);
	});

	test.each([
		false,
		true,
	])("history barrier honors cloud opt-in: %s", async (background) => {
		const frames = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed("event-complete-history"),
				);
				yield* domain.dispatch({
					commandId: "command-create-history",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* Effect.forEach(
					Array.from({ length: 262 }, (_, index) => index + 1),
					(sequence) => sql`
						INSERT INTO messages
							(id, session_id, role, kind, content_json, parent_item_id,
							 created_at, sequence)
						VALUES
							(${`message-${sequence}`}, 'session-1', 'assistant', 'assistant',
							 ${JSON.stringify({ _tag: "assistant", text: `message ${sequence}` })},
							 NULL, '2026-01-01T00:00:00.000Z', ${sequence})
					`,
					{ discard: true },
				);
				return [
					...(yield* domain
						.synchronizedEvents({
							streamId: "session-1",
							hasProjection: false,
							...(background ? { historyMode: "background" as const } : {}),
						})
						.pipe(
							Stream.takeUntil((frame) => frame.kind === "synchronized"),
							Stream.runCollect,
						)),
				];
			}),
		);
		const snapshot = frames[0];
		expect(snapshot).toMatchObject({
			kind: "snapshot",
			totalMessageCount: 262,
		});
		const messages = frames.flatMap((frame) =>
			frame.kind === "snapshot"
				? frame.projection.messages
				: frame.kind === "snapshot-chunk"
					? frame.messages
					: [],
		);
		if (background) {
			expect(messages.length).toBeLessThan(262);
			expect(frames).toHaveLength(2);
			expect(snapshot).toMatchObject({ historyMode: "background" });
		} else expect(messages).toHaveLength(262);
		expect(messages.at(-1)?.id).toBe(background ? "message-262" : "message-62");
		expect(frames.at(-1)).toMatchObject({ kind: "synchronized" });
	});

	test("tails durable session events dispatched by another runtime", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-session-domain-sync-"));
		const filename = join(directory, "shared.sqlite");
		const schemaRuntime = ManagedRuntime.make(sqliteLayer({ filename }));
		await schemaRuntime.runPromise(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
			}),
		);
		await schemaRuntime.dispose();
		const firstRuntime = makeDomainRuntime(filename, "first-event");
		const secondRuntime = makeDomainRuntime(filename, "second-event");
		try {
			await firstRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "command-create",
						streamId: "session-1",
						command: createSessionCommand,
					}),
				),
			);
			const synchronized = Deferred.makeUnsafe<void>();
			const collecting = secondRuntime.runFork(
				Effect.flatMap(SessionDomain, (domain) =>
					domain
						.synchronizedEvents({
							streamId: "session-1",
							afterVersion: 1,
							hasProjection: true,
						})
						.pipe(
							Stream.filter(
								(frame) =>
									frame.kind === "synchronized" ||
									(frame.kind === "event" &&
										frame.record.event._tag === "MessagePersisted"),
							),
							Stream.tap((frame) =>
								frame.kind === "synchronized"
									? Deferred.succeed(synchronized, undefined)
									: Effect.void,
							),
							Stream.take(2),
							Stream.runCollect,
						),
				),
			);
			await Effect.runPromise(Deferred.await(synchronized));
			await firstRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					domain.dispatch({
						commandId: "command-submit-turn",
						streamId: "session-1",
						command: {
							_tag: "SubmitTurn",
							turnId: "turn-remote",
							messageId: "message-remote",
							role: "user",
							kind: "user",
							contentJson: '{"_tag":"user","text":"hello from web"}',
							parentItemId: null,
							providerInputJson: '{"text":"hello from web"}',
							createdAt: 2,
						},
					}),
				),
			);
			const frames = await Effect.runPromise(
				Fiber.join(collecting).pipe(Effect.timeout(1_000)),
			);

			expect([...frames]).toMatchObject([
				{ kind: "synchronized", throughVersion: 1 },
				{
					kind: "event",
					record: {
						streamVersion: 2,
						event: {
							_tag: "MessagePersisted",
							messageId: "message-remote",
							contentJson: '{"_tag":"user","text":"hello from web"}',
						},
					},
				},
			]);
		} finally {
			await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()]);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("replays only the retained session version prefix", async () => {
		const frames = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: { _tag: "SetTitle", title: "Renamed", updatedAt: 2 },
				});
				return yield* domain
					.synchronizedEvents({
						streamId: "session-1",
						afterVersion: 1,
						hasProjection: true,
					})
					.pipe(Stream.take(2), Stream.runCollect);
			}),
		);

		expect([...frames]).toMatchObject([
			{ kind: "event", record: { streamVersion: 2 } },
			{ kind: "synchronized", throughVersion: 2 },
		]);
	});

	test("falls back to one bounded snapshot when the delta byte budget is exceeded", async () => {
		const frames = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: {
						_tag: "SetTitle",
						title: "A title that cannot fit in a one-byte delta budget",
						updatedAt: 2,
					},
				});
				return yield* domain
					.synchronizedEvents({
						streamId: "session-1",
						afterVersion: 1,
						hasProjection: true,
						maxDeltaBytes: 1,
					})
					.pipe(Stream.take(2), Stream.runCollect);
			}),
		);

		expect([...frames]).toMatchObject([
			{ kind: "snapshot", throughVersion: 2 },
			{ kind: "synchronized", throughVersion: 2 },
		]);
	});

	test("catches a completed disconnected turn through one bounded cursor without regression", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-client-reconnect-"));
		const filename = join(directory, "session.sqlite");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* createDomainTestSchema();
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO app_state (key, value)
						VALUES ('session_stream_epoch', 'epoch-reconnect')
					`;
					yield* sql`
						INSERT INTO chats (id, updated_at)
						VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
					`;
				}).pipe(Effect.provide(sqliteLayer({ filename }))),
			),
		);

		const runtimeBeforeDisconnect = makeDomainRuntime(filename, "before");
		let retainedVersion = 0;
		try {
			retainedVersion = await runtimeBeforeDisconnect.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						yield* domain.dispatch({
							commandId: "create-reconnect-session",
							streamId: "session-1",
							command: createSessionCommand,
						});
						const accepted = yield* domain.dispatch({
							commandId: "accepted-prompt",
							streamId: "session-1",
							command: {
								_tag: "SubmitTurn",
								turnId: "turn-1",
								messageId: "user-message-1",
								role: "user",
								kind: "user",
								contentJson:
									'{"_tag":"user","text":"finish while closed","goal":false}',
								parentItemId: null,
								providerInputJson:
									'{"text":"finish while closed","attachments":[],"fileRefs":[],"skillRefs":[]}',
								createdAt: 2,
							},
						});
						return accepted.streamVersion;
					}),
				),
			);
		} finally {
			await runtimeBeforeDisconnect.dispose();
		}

		const runtimeWhileClientGone = makeDomainRuntime(filename, "background");
		try {
			await runtimeWhileClientGone.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						yield* domain.dispatch({
							commandId: "provider-checkpoint-1",
							streamId: "session-1",
							command: {
								_tag: "PersistMessage",
								messageId: "provider-message-1",
								turnId: "turn-1",
								role: "assistant",
								kind: "assistant",
								contentJson:
									'{"_tag":"assistant","text":"partial","checkpoint":{"revision":1,"final":false}}',
								parentItemId: null,
								checkpointRevision: 1,
								checkpointFinal: false,
								createdAt: 3,
							},
						});
						yield* domain.dispatch({
							commandId: "provider-checkpoint-2",
							streamId: "session-1",
							command: {
								_tag: "PersistMessage",
								messageId: "provider-message-1",
								turnId: "turn-1",
								role: "assistant",
								kind: "assistant",
								contentJson:
									'{"_tag":"assistant","text":"complete","checkpoint":{"revision":2,"final":true}}',
								parentItemId: null,
								checkpointRevision: 2,
								checkpointFinal: true,
								createdAt: 4,
							},
						});
						yield* domain.dispatch({
							commandId: "settle-background-turn",
							streamId: "session-1",
							command: {
								_tag: "SettleTurn",
								turnId: "turn-1",
								outcome: "completed",
								settledAt: 5,
							},
						});
					}),
				),
			);
		} finally {
			await runtimeWhileClientGone.dispose();
		}

		const reconnectRuntime = makeDomainRuntime(filename, "reconnect");
		try {
			const result = await reconnectRuntime.runPromise(
				Effect.flatMap(SessionDomain, (domain) =>
					Effect.gen(function* () {
						const frames = yield* domain
							.synchronizedEvents({
								streamId: "session-1",
								afterVersion: retainedVersion,
								streamEpoch: "epoch-reconnect",
								hasProjection: true,
							})
							.pipe(
								Stream.takeUntil((frame) => frame.kind === "synchronized"),
								Stream.runCollect,
							);
						const sql = yield* SqlClient.SqlClient;
						const messages = yield* sql<{
							readonly id: string;
							readonly content_json: string;
							readonly checkpoint_revision: number | null;
							readonly checkpoint_final: number | null;
						}>`
							SELECT id, content_json, checkpoint_revision, checkpoint_final
							FROM messages WHERE session_id = 'session-1'
							ORDER BY sequence
						`;
						const session = yield* sql<{
							readonly status: string;
							readonly active_turn_id: string | null;
						}>`
							SELECT s.status,
								(SELECT t.id FROM session_turns t
									WHERE t.session_id = s.id AND t.status IN ('starting', 'running')
									LIMIT 1) AS active_turn_id
							FROM sessions s WHERE s.id = 'session-1'
						`;
						return { frames: [...frames], messages, session };
					}),
				),
			);

			expect(result.frames.at(-1)).toMatchObject({
				kind: "synchronized",
				streamEpoch: "epoch-reconnect",
			});
			const eventFrames = result.frames.filter(
				(frame) => frame.kind === "event",
			);
			expect(eventFrames).toHaveLength(4);
			expect(eventFrames.map((frame) => frame.record.streamVersion)).toEqual(
				Array.from(
					{ length: eventFrames.length },
					(_, index) => retainedVersion + index + 1,
				),
			);
			expect(
				new Set(eventFrames.map((frame) => frame.record.eventId)).size,
			).toBe(eventFrames.length);
			expect(result.frames.some((frame) => frame.kind === "snapshot")).toBe(
				false,
			);
			expect(result.messages).toEqual([
				expect.objectContaining({ id: "user-message-1" }),
				{
					id: "provider-message-1",
					content_json:
						'{"_tag":"assistant","text":"complete","checkpoint":{"revision":2,"final":true}}',
					checkpoint_revision: 2,
					checkpoint_final: 1,
				},
			]);
			expect(result.session).toEqual([
				{ status: "idle", active_turn_id: null },
			]);
		} finally {
			await reconnectRuntime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("receipts fence a delayed interrupt from a successor turn", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`interrupt-event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "start-1",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-1", startedAt: 2 },
				});
				yield* domain.dispatch({
					commandId: "settle-1",
					streamId: "session-1",
					command: {
						_tag: "SettleTurn",
						turnId: "turn-1",
						outcome: "completed",
						settledAt: 3,
					},
				});
				yield* domain.dispatch({
					commandId: "start-2",
					streamId: "session-1",
					command: { _tag: "StartTurn", turnId: "turn-2", startedAt: 4 },
				});
				const stale = yield* domain.dispatch({
					commandId: "interrupt-stale",
					streamId: "session-1",
					command: {
						_tag: "RequestTurnInterrupt",
						expectedTurnId: "turn-1",
						requestedAt: 5,
					},
				});
				const current = yield* domain.dispatch({
					commandId: "interrupt-current",
					streamId: "session-1",
					command: {
						_tag: "RequestTurnInterrupt",
						expectedTurnId: "turn-2",
						requestedAt: 6,
					},
				});
				const interruptRows = yield* sql<{
					readonly turn_id: string | null;
				}>`
					SELECT json_extract(payload_json, '$.turnId') AS turn_id
					FROM events WHERE stream_id = 'session-1'
						AND type = 'TurnInterruptRequested'
					ORDER BY stream_version
				`;
				return { stale, current, interruptRows };
			}),
		);

		expect(result.stale.result).toEqual({
			_tag: "not-active",
			reason: "turn-mismatch",
			expectedTurnId: "turn-1",
			actualTurnId: "turn-2",
		});
		expect(result.stale.eventIds).toEqual([]);
		expect(result.current.result).toEqual({
			_tag: "requested",
			turnId: "turn-2",
		});
		expect(result.interruptRows).toEqual([{ turn_id: "turn-2" }]);
	});
});

test.each([
	"current",
	"unrelated",
	"replaced-residency",
	"wrong-attempt",
	"newer-turn",
	"no-residency",
	"old-anchor",
	"terminal",
] as const)("fences late completed tool output (%s)", async (mode) => {
	await run(
		Effect.gen(function* () {
			yield* createDomainTestSchema();
			const sql = yield* SqlClient.SqlClient;
			let sequence = 0;
			const domain = yield* makeSessionDomain(sql, () =>
				Effect.succeed(`tail-${++sequence}`),
			);
			const dispatch = (command: SessionCommand) =>
				domain.dispatch({
					commandId: `command-${++sequence}`,
					streamId: "session-1",
					command,
				});
			yield* dispatch(createSessionCommand);
			yield* dispatch({
				_tag: "ReserveProviderSession",
				providerId: "provider-1",
				providerSessionId: "resident",
				reservedAt: 1,
			});
			yield* dispatch({ _tag: "StartTurn", turnId: "turn-1", startedAt: 2 });
			yield* dispatch({
				_tag: "PersistMessage",
				turnId: "turn-1",
				messageId: "tool",
				role: "assistant",
				kind: "tool_use",
				contentJson: JSON.stringify({
					_tag: "tool_use",
					itemId: "tool-1",
					tool: "Bash",
					input: {},
				}),
				parentItemId: null,
				createdAt: 3,
			});
			if (mode === "old-anchor")
				yield* dispatch({
					_tag: "RetryTurn",
					turnId: "turn-1",
					reason: "retry",
					providerInputJson: "{}",
					requestedAt: 3,
				});
			yield* dispatch({
				_tag: "SettleTurn",
				turnId: "turn-1",
				outcome: "completed",
				settledAt: 4,
			});
			if (mode === "replaced-residency")
				yield* dispatch({
					_tag: "ReserveProviderSession",
					providerId: "provider-1",
					providerSessionId: "replacement",
					reservedAt: 5,
				});
			if (mode === "newer-turn")
				yield* dispatch({ _tag: "StartTurn", turnId: "turn-2", startedAt: 5 });
			const result = yield* domain
				.dispatch({
					commandId: "late",
					streamId: "session-1",
					expectedProviderSessionId:
						mode === "no-residency" ? undefined : "resident",
					expectedAttempt: {
						turnId: "turn-1",
						attemptId: attemptIdFor(
							"turn-1",
							mode === "wrong-attempt" || mode === "old-anchor" ? 2 : 1,
						),
					},
					command:
						mode === "terminal"
							? {
									_tag: "SettleTurn",
									turnId: "turn-1",
									outcome: "error",
									settledAt: 6,
								}
							: {
									_tag: "PersistMessage",
									turnId: "turn-1",
									messageId: "result",
									role: "tool",
									kind: "tool_result",
									contentJson: JSON.stringify({
										_tag: "tool_result",
										itemId: mode === "unrelated" ? "unknown" : "tool-1",
										output: "done",
										isError: false,
									}),
									parentItemId: null,
									createdAt: 6,
								},
				})
				.pipe(Effect.result);
			expect(result._tag === "Success").toBe(mode === "current");
		}),
	);
});
