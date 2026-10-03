import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AgentTurnId, SessionId } from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { makeSqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { captureGitCheckpoint } from "@zuse/git/checkpoints";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { makeCheckpointRestore } from "../../src/conversation/core/checkpoint-restore.ts";
import { sessionFromRecord } from "../../src/conversation/core/conversation-records.ts";
import { makeSessionCheckpoints } from "../../src/conversation/core/session-checkpoints.ts";
import { reconcileSessionRuntime } from "../../src/conversation/core/startup-recovery.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";
import type { ProviderServiceShape } from "../../src/provider/services/provider-service.ts";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
	(await execute("git", ["-C", cwd, ...args])).stdout.trim();
const sid = SessionId.make("session-1");
const turn = AgentTurnId.make("turn-1");

const fixture = async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "zuse-rollback-"));
	const cwd = path.join(root, "repo");
	await execute("git", ["init", "-q", cwd]);
	await git(cwd, "config", "user.name", "Test");
	await git(cwd, "config", "user.email", "test@localhost");
	await writeFile(path.join(cwd, "code.txt"), "before\n");
	await git(cwd, "add", ".");
	await git(cwd, "commit", "-qm", "base");
	const sqlLayer = sqliteLayer({ filename: path.join(root, "db.sqlite") });
	const runtime = ManagedRuntime.make(
		Layer.merge(sqlLayer, MigrationsLive.pipe(Layer.provide(sqlLayer))),
	);
	const run = <A, E>(
		effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
	) => runtime.runPromise(Effect.scoped(effect));
	const setup = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const domain = yield* makeSessionDomain(sql, () =>
			Effect.succeed(crypto.randomUUID()),
		);
		const queries = makeSqlSessionQueries(sql);
		return {
			sql,
			domain,
			queries,
			getSession: (id: SessionId) =>
				queries.get(id).pipe(Effect.map(sessionFromRecord), Effect.orDie),
		};
	});
	await run(
		Effect.gen(function* () {
			const { sql, domain } = yield* setup;
			yield* sql`INSERT INTO projects(id,path,name,created_at,updated_at) VALUES('project-1',${cwd},'repo','2026-01-01','2026-01-01')`;
			yield* sql`INSERT INTO chats(id,project_id,title,created_at,updated_at) VALUES('chat-1','project-1','Chat','2026-01-01','2026-01-01')`;
			yield* domain.dispatch({
				commandId: "create",
				streamId: sid,
				command: { ...createSessionCommand, providerId: "codex" },
			});
			yield* domain.dispatch({
				commandId: "history",
				streamId: sid,
				command: {
					_tag: "PersistMessage",
					messageId: "history",
					turnId: null,
					role: "user",
					kind: "user",
					contentJson: JSON.stringify({
						_tag: "user",
						text: "Keep this history",
					}),
					parentItemId: null,
					createdAt: 1,
				},
			});
			yield* domain.dispatch({
				commandId: "start",
				streamId: sid,
				command: { _tag: "StartTurn", turnId: turn, startedAt: 2 },
			});
			const checkpoints = makeSessionCheckpoints(
				sql,
				{ isRepository: () => Effect.succeed(true) },
				{ capture: captureGitCheckpoint },
			);
			yield* checkpoints.capture(
				yield* setup.pipe(Effect.flatMap((f) => f.getSession(sid))),
				turn,
				"attempt:1",
				"baseline",
			);
			yield* Effect.promise(() =>
				writeFile(path.join(cwd, "code.txt"), "after\n"),
			);
			yield* domain.dispatch({
				commandId: "reply",
				streamId: sid,
				command: {
					_tag: "PersistMessage",
					messageId: "reply",
					turnId: turn,
					role: "assistant",
					kind: "assistant",
					contentJson: JSON.stringify({
						_tag: "assistant",
						text: "Remove this history",
					}),
					parentItemId: null,
					createdAt: 3,
				},
			});
			yield* checkpoints.capture(
				yield* setup.pipe(Effect.flatMap((f) => f.getSession(sid))),
				turn,
				"attempt:1",
				"final",
				"completed",
			);
			yield* domain.dispatch({
				commandId: "settle",
				streamId: sid,
				command: {
					_tag: "SettleTurn",
					turnId: turn,
					outcome: "completed",
					settledAt: 4,
				},
			});
		}),
	);
	const service = (
		failurePoint: false | "before-transcript" | "after-transcript" = false,
		provider: Pick<
			ProviderServiceShape,
			"close" | "hasSession" | "quiesce" | "restoreHistoryCheckpoint"
		> = { close: () => Effect.void, hasSession: () => Effect.succeed(false) },
	) =>
		Effect.gen(function* () {
			const f = yield* setup;
			const domain =
				failurePoint !== false
					? {
							...f.domain,
							dispatch: (input: Parameters<typeof f.domain.dispatch>[0]) =>
								input.command._tag === "RollbackTurns"
									? failurePoint === "before-transcript"
										? Effect.die(new Error("injected process loss after files"))
										: f.domain
												.dispatch(input)
												.pipe(
													Effect.andThen(
														Effect.die(
															new Error(
																"injected process loss after transcript",
															),
														),
													),
												)
									: f.domain.dispatch(input),
						}
					: f.domain;
			return yield* makeCheckpointRestore({
				sql: f.sql,
				domain,
				getSession: f.getSession,
				activeTurnCount: f.queries.activeTurnCount,
				provider,
				teardown: () => Effect.void,
				retryFinalization: () => Effect.void,
			});
		});
	return {
		root,
		cwd,
		run,
		setup,
		service,
		close: async () => {
			await runtime.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
};
it("restores real files, truncates transcript, marks turns and freezes fresh provider context", async () => {
	const f = await fixture();
	try {
		await f.run(
			Effect.gen(function* () {
				const svc = yield* f.service();
				const rows = yield* svc.list(sid);
				const target = rows.find((row) => row.phase === "baseline");
				if (target === undefined) throw new Error("Missing baseline");
				const preview = yield* svc.preview(sid, target.id);
				expect(preview.files).toEqual(["code.txt"]);
				yield* svc.restore(sid, preview.previewId);
				yield* svc.restore(sid, preview.previewId);
				const { sql } = yield* f.setup;
				expect(yield* sql`SELECT status FROM session_turns`).toEqual([
					{ status: "rolled_back" },
				]);
				expect(yield* sql`SELECT id FROM messages ORDER BY sequence`).toEqual([
					{ id: "history" },
				]);
				const context = yield* sql<{
					context_text: string;
				}>`SELECT context_text FROM session_context_handoffs WHERE active=1`;
				expect(context[0]?.context_text).toContain("Keep this history");
				expect(context[0]?.context_text).not.toContain("Remove this history");
				expect(
					yield* sql`SELECT id FROM session_checkpoint_restores WHERE completed_at IS NULL`,
				).toEqual([]);
			}),
		);
		expect(await readFile(path.join(f.cwd, "code.txt"), "utf8")).toBe(
			"before\n",
		);
	} finally {
		await f.close();
	}
});
it.each([
	"before-transcript",
	"after-transcript",
] as const)("recovers %s without conflicting command receipts or resending provider work", async (failurePoint) => {
	const f = await fixture();
	try {
		let previewId = "";
		await f.run(
			Effect.gen(function* () {
				const svc = yield* f.service(failurePoint);
				const target = (yield* svc.list(sid)).find(
					(row) => row.phase === "baseline",
				);
				if (target === undefined) throw new Error("Missing baseline");
				previewId = (yield* svc.preview(sid, target.id)).previewId;
				expect(
					(yield* svc.restore(sid, previewId).pipe(Effect.exit))._tag,
				).toBe("Failure");
				const { domain } = yield* f.setup;
				expect(
					(yield* domain
						.dispatch({
							commandId: "blocked",
							streamId: sid,
							command: { _tag: "StartTurn", turnId: "blocked", startedAt: 10 },
						})
						.pipe(Effect.exit))._tag,
				).toBe("Failure");
			}),
		);
		expect(await readFile(path.join(f.cwd, "code.txt"), "utf8")).toBe(
			"before\n",
		);
		await f.run(
			Effect.gen(function* () {
				const fresh = yield* f.service();
				yield* fresh.recover;
				yield* fresh.restore(sid, previewId);
				const { sql } = yield* f.setup;
				expect(
					yield* sql`SELECT id FROM session_checkpoint_restores WHERE completed_at IS NULL`,
				).toEqual([]);
				expect(yield* sql`SELECT id FROM messages ORDER BY sequence`).toEqual([
					{ id: "history" },
				]);
			}),
		);
	} finally {
		await f.close();
	}
});
it("rejects stale preview edits before changing files or transcript", async () => {
	const f = await fixture();
	try {
		await f.run(
			Effect.gen(function* () {
				const svc = yield* f.service();
				const target = (yield* svc.list(sid)).find(
					(row) => row.phase === "baseline",
				);
				if (target === undefined) throw new Error("Missing baseline");
				const preview = yield* svc.preview(sid, target.id);
				yield* Effect.promise(() =>
					writeFile(path.join(f.cwd, "code.txt"), "external\n"),
				);
				expect(
					(yield* svc.restore(sid, preview.previewId).pipe(Effect.exit))._tag,
				).toBe("Failure");
				const { sql } = yield* f.setup;
				expect((yield* sql`SELECT id FROM messages`).length).toBe(2);
				expect(
					yield* sql`SELECT status FROM session_checkpoint_restores`,
				).toEqual([{ status: "cancelled" }]);
			}),
		);
		expect(await readFile(path.join(f.cwd, "code.txt"), "utf8")).toBe(
			"external\n",
		);
	} finally {
		await f.close();
	}
});

it("keeps a finalizing turn active through capture failure and restart, then settles after retry", async () => {
	const f = await fixture();
	try {
		await f.run(
			Effect.gen(function* () {
				const { domain, sql, queries, getSession } = yield* f.setup;
				const finalTurn = AgentTurnId.make("finalizing-turn");
				yield* domain.dispatch({
					commandId: "start-finalizing",
					streamId: sid,
					command: { _tag: "StartTurn", turnId: finalTurn, startedAt: 20 },
				});
				yield* domain.dispatch({
					commandId: "finalize",
					streamId: sid,
					command: {
						_tag: "FinalizeTurn",
						turnId: finalTurn,
						outcome: "completed",
						settledAt: 21,
					},
				});
				expect(yield* queries.activeTurnCount).toBe(1);
				expect(
					yield* sql`SELECT kind FROM jobs WHERE status='pending'`,
				).toEqual([{ kind: "checkpoint.capture" }]);
				const bad = makeSessionCheckpoints(
					sql,
					{ isRepository: () => Effect.succeed(true) },
					{
						capture: async () => {
							throw new Error("injected capture failure");
						},
					},
				);
				expect(
					(yield* bad
						.capture(
							yield* getSession(sid),
							finalTurn,
							"final-attempt",
							"final",
							"completed",
						)
						.pipe(Effect.exit))._tag,
				).toBe("Failure");
				const fresh = yield* f.setup;
				yield* reconcileSessionRuntime(sql, fresh.domain);
				expect(
					yield* sql`SELECT status FROM session_turns WHERE id=${finalTurn}`,
				).toEqual([{ status: "finalizing" }]);
				expect(
					(yield* fresh.domain
						.dispatch({
							commandId: "too-early",
							streamId: sid,
							command: { _tag: "StartTurn", turnId: "next", startedAt: 22 },
						})
						.pipe(Effect.exit))._tag,
				).toBe("Failure");
				const healthy = makeSessionCheckpoints(
					sql,
					{ isRepository: () => Effect.succeed(true) },
					{ capture: captureGitCheckpoint },
				);
				yield* healthy.capture(
					yield* getSession(sid),
					finalTurn,
					"final-attempt",
					"final",
					"completed",
				);
				yield* fresh.domain.dispatch({
					commandId: "finally-settled",
					streamId: sid,
					command: {
						_tag: "SettleTurn",
						turnId: finalTurn,
						outcome: "completed",
						settledAt: 23,
					},
				});
				expect(yield* queries.activeTurnCount).toBe(0);
				expect(
					yield* sql`SELECT status FROM session_checkpoints WHERE turn_id=${finalTurn}`,
				).toEqual([{ status: "ready" }]);
			}),
		);
	} finally {
		await f.close();
	}
});

it("keeps the original counted-turn baseline when another attempt starts", async () => {
	const f = await fixture();
	try {
		await f.run(
			Effect.gen(function* () {
				const { sql, getSession } = yield* f.setup;
				const before = yield* sql<{
					id: string;
					commit_id: string;
				}>`SELECT id,commit_id FROM session_checkpoints WHERE phase='baseline'`;
				const checkpoints = makeSessionCheckpoints(
					sql,
					{ isRepository: () => Effect.succeed(true) },
					{ capture: captureGitCheckpoint },
				);
				yield* checkpoints.capture(
					yield* getSession(sid),
					turn,
					"retry-attempt",
					"baseline",
				);
				expect(
					yield* sql`SELECT id,commit_id FROM session_checkpoints WHERE phase='baseline'`,
				).toEqual(before);
			}),
		);
	} finally {
		await f.close();
	}
});

it.each([
	true,
	false,
])("uses native history only when boundary verification succeeds (%s)", async (verified) => {
	const f = await fixture();
	try {
		await f.run(
			Effect.gen(function* () {
				const { sql, domain, getSession } = yield* f.setup;
				const native = {
					providerId: "codex",
					nativeThreadId: "native-thread",
					turnIds: ["native-turn-1"],
				};
				yield* domain.dispatch({
					commandId: "bind-native",
					streamId: sid,
					command: {
						_tag: "BindProviderThread",
						nativeThreadId: native.nativeThreadId,
						nativeHeadId: "later-turn",
						updatedAt: 5,
					},
				});
				yield* sql`UPDATE session_checkpoints SET native_history_json=${JSON.stringify(native)} WHERE phase='final'`;
				let restored = 0;
				let closed = false;
				const service = yield* f.service(false, {
					hasSession: () => Effect.succeed(!closed),
					close: () =>
						Effect.promise(async () => {
							expect(await readFile(path.join(f.cwd, "code.txt"), "utf8")).toBe(
								"future\n",
							);
							closed = true;
						}),
					restoreHistoryCheckpoint: (_session, checkpoint) =>
						Effect.sync(() => {
							expect(closed).toBe(false);
							expect(checkpoint).toEqual(native);
							restored++;
							return verified;
						}),
				});
				const checkpoints = yield* service.list(sid);
				const target = checkpoints.find((row) => row.phase === "final");
				if (target === undefined) throw new Error("missing final checkpoint");
				yield* Effect.promise(() =>
					writeFile(path.join(f.cwd, "code.txt"), "future\n"),
				);
				const preview = yield* service.preview(sid, target.id);
				yield* service.restore(sid, preview.previewId);
				expect(restored).toBe(1);
				const journal = yield* sql<{
					native_attempted: number;
					native_verified_json: string | null;
				}>`SELECT native_attempted,native_verified_json FROM session_checkpoint_restores WHERE id=${preview.previewId}`;
				expect(journal[0]?.native_attempted).toBe(1);
				expect(journal[0]?.native_verified_json !== null).toBe(verified);
				expect(closed).toBe(true);
				expect(
					(yield* getSession(sid)).providerThread?.nativeHeadRef?.nativeId,
				).toBe(verified ? "native-turn-1" : undefined);
				const coverage = yield* sql<{
					through_sequence: number;
				}>`SELECT through_sequence FROM session_provider_contexts WHERE session_id=${sid}`;
				const cutoff = yield* sql<{
					message_sequence: number;
				}>`SELECT message_sequence FROM session_checkpoints WHERE id=${target.id}`;
				expect(coverage[0]?.through_sequence).toBe(
					verified ? cutoff[0]?.message_sequence : undefined,
				);
				const handoffs =
					yield* sql`SELECT id FROM session_context_handoffs WHERE session_id=${sid} AND active=1`;
				expect(handoffs).toHaveLength(verified ? 0 : 1);
				expect(
					yield* Effect.promise(() =>
						readFile(path.join(f.cwd, "code.txt"), "utf8"),
					),
				).toBe("after\n");
			}),
		);
	} finally {
		await f.close();
	}
});

it("keeps the restore fence and leaves files untouched when provider quiescence cannot be proved", async () => {
	const f = await fixture();
	try {
		await f.run(
			Effect.gen(function* () {
				const service = yield* f.service(false, {
					hasSession: () => Effect.succeed(true),
					close: () => Effect.void,
					quiesce: () => Effect.fail(new Error("still running")),
				});
				const target = (yield* service.list(sid)).find(
					(row) => row.phase === "baseline",
				);
				if (target === undefined) throw new Error("missing baseline");
				const preview = yield* service.preview(sid, target.id);
				const result = yield* service
					.restore(sid, preview.previewId)
					.pipe(Effect.result);
				expect(result._tag).toBe("Failure");
				expect(
					yield* Effect.promise(() =>
						readFile(path.join(f.cwd, "code.txt"), "utf8"),
					),
				).toBe("after\n");
				const { sql } = yield* f.setup;
				const rows = yield* sql<{
					completed_at: number | null;
				}>`SELECT completed_at FROM session_checkpoint_restores WHERE id=${preview.previewId}`;
				expect(rows[0]?.completed_at).toBe(null);
			}),
		);
	} finally {
		await f.close();
	}
});

it("retains the restore fence after native rewind if files change before the guarded apply", async () => {
	const f = await fixture();
	try {
		await f.run(
			Effect.gen(function* () {
				const { sql, domain } = yield* f.setup;
				const native = {
					providerId: "codex",
					nativeThreadId: "native-thread",
					turnIds: ["native-turn-1"],
				};
				yield* domain.dispatch({
					commandId: "bind-native",
					streamId: sid,
					command: {
						_tag: "BindProviderThread",
						nativeThreadId: native.nativeThreadId,
						updatedAt: 5,
					},
				});
				yield* sql`UPDATE session_checkpoints SET native_history_json=${JSON.stringify(native)} WHERE phase='final'`;
				let calls = 0;
				const service = yield* f.service(false, {
					hasSession: () => Effect.succeed(true),
					close: () => Effect.void,
					restoreHistoryCheckpoint: () =>
						Effect.promise(async () => {
							calls++;
							await writeFile(path.join(f.cwd, "code.txt"), "external edit\n");
							return true;
						}),
				});
				const target = (yield* service.list(sid)).find(
					(row) => row.phase === "final",
				);
				if (target === undefined) throw new Error("missing final");
				const preview = yield* service.preview(sid, target.id);
				expect(
					(yield* service.restore(sid, preview.previewId).pipe(Effect.result))
						._tag,
				).toBe("Failure");
				expect(calls).toBe(1);
				expect(
					yield* Effect.promise(() =>
						readFile(path.join(f.cwd, "code.txt"), "utf8"),
					),
				).toBe("external edit\n");
				const journal = yield* sql<{
					native_attempted: number;
					completed_at: number | null;
				}>`SELECT native_attempted,completed_at FROM session_checkpoint_restores WHERE id=${preview.previewId}`;
				expect(journal[0]).toEqual({ native_attempted: 1, completed_at: null });
				const messages =
					yield* sql`SELECT id FROM messages WHERE session_id=${sid}`;
				expect(messages).toHaveLength(2);
			}),
		);
	} finally {
		await f.close();
	}
});

it("recovers a crash after verified native rewind through portable history without replaying native mutation", async () => {
	const f = await fixture();
	try {
		await f.run(
			Effect.gen(function* () {
				const { sql, domain, getSession } = yield* f.setup;
				const native = {
					providerId: "codex",
					nativeThreadId: "native-thread",
					turnIds: ["native-turn-1"],
				};
				yield* domain.dispatch({
					commandId: "bind-native",
					streamId: sid,
					command: {
						_tag: "BindProviderThread",
						nativeThreadId: native.nativeThreadId,
						updatedAt: 5,
					},
				});
				yield* sql`UPDATE session_checkpoints SET native_history_json=${JSON.stringify(native)} WHERE phase='final'`;
				let nativeCalls = 0;
				const crashing = yield* f.service(false, {
					hasSession: () => Effect.succeed(true),
					close: () =>
						Effect.die(new Error("simulated engine loss after native rewind")),
					restoreHistoryCheckpoint: () =>
						Effect.sync(() => {
							nativeCalls++;
							return true;
						}),
				});
				const target = (yield* crashing.list(sid)).find(
					(row) => row.phase === "final",
				);
				if (target === undefined) throw new Error("missing final");
				yield* Effect.promise(() =>
					writeFile(path.join(f.cwd, "code.txt"), "future\n"),
				);
				const preview = yield* crashing.preview(sid, target.id);
				expect(
					(yield* crashing.restore(sid, preview.previewId).pipe(Effect.exit))
						._tag,
				).toBe("Failure");
				expect(
					yield* Effect.promise(() =>
						readFile(path.join(f.cwd, "code.txt"), "utf8"),
					),
				).toBe("future\n");
				const recovered = yield* f.service();
				yield* recovered.recover;
				expect(nativeCalls).toBe(1);
				expect(
					yield* Effect.promise(() =>
						readFile(path.join(f.cwd, "code.txt"), "utf8"),
					),
				).toBe("after\n");
				expect((yield* getSession(sid)).providerThread).toBe(null);
				const handoffs = yield* sql<{
					context_text: string;
				}>`SELECT context_text FROM session_context_handoffs WHERE session_id=${sid} AND active=1`;
				expect(handoffs[0]?.context_text).toContain("Remove this history");
				const journal = yield* sql<{
					completed_at: number | null;
					native_attempted: number;
				}>`SELECT completed_at,native_attempted FROM session_checkpoint_restores WHERE id=${preview.previewId}`;
				expect(journal[0]?.native_attempted).toBe(1);
				expect(journal[0]?.completed_at).not.toBe(null);
			}),
		);
	} finally {
		await f.close();
	}
});
