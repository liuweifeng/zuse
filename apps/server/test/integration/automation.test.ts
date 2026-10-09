import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { makeAutomationService } from "../../src/automation/service.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";

const sessionId = SessionId.make("owner");
const makeFixture = () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-automation-"));
	const secrets = new Map<string, string>();
	const credentials = {
		getIntegration: (_integration: string, key: string) =>
			Effect.succeed(secrets.get(key) ?? null),
		setIntegration: (_integration: string, key: string, value: string) =>
			Effect.sync(() => {
				secrets.set(key, value);
			}),
		listIntegrationAccounts: () => Effect.succeed([...secrets.keys()]),
	};
	const open = () => {
		const sql = sqliteLayer({ filename: join(directory, "db.sqlite") });
		return ManagedRuntime.make(
			Layer.merge(sql, MigrationsLive.pipe(Layer.provide(sql))),
		);
	};
	const service = Effect.map(SqlClient.SqlClient, (sql) =>
		makeAutomationService(sql, credentials),
	);
	const seed = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('p','/tmp','P','2026','2026')`;
		yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('c','p','C','2026','2026')`;
		yield* sql`INSERT INTO sessions (id,project_id,chat_id,title,provider_id,model,status,created_at,updated_at) VALUES ('owner','p','c','S','codex','test','idle','2026','2026'), ('other','p','c','Other','codex','test','idle','2026','2026')`;
		yield* sql`CREATE TABLE delivered (id TEXT PRIMARY KEY, prompt TEXT)`;
	});
	const sweep = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const automation = yield* service;
		yield* automation.sweep((_session, commandId, prompt, committed) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`INSERT INTO delivered VALUES (${commandId}, ${prompt})`;
					yield* committed;
				}),
			),
		);
	});
	return {
		open,
		service,
		seed,
		sweep,
		secrets,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
};

it("recovers pending scheduled delivery across restart without duplicate execution", async () => {
	const fixture = makeFixture();
	let runtime = fixture.open();
	try {
		await runtime.runPromise(fixture.seed);
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* fixture.service;
				const input = {
					sessionId,
					clientRequestId: "once",
					title: "Check",
					prompt: "check",
					schedule: { kind: "once" as const, at: 0 },
				};
				expect((yield* service.create(input)).id).toBe(
					(yield* service.create(input)).id,
				);
				yield* service.sweep(() =>
					Effect.fail("runtime stopped before delivery"),
				);
			}),
		);
		await runtime.dispose();
		runtime = fixture.open();
		await runtime.runPromise(
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) => sql`UPDATE scheduled_task_deliveries SET retry_after = 0`,
			),
		);
		await runtime.runPromise(fixture.sweep);
		await runtime.runPromise(fixture.sweep);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT prompt FROM delivered`).toEqual([
					{ prompt: "check" },
				]);
				expect(yield* sql`SELECT last_error FROM scheduled_tasks`).toEqual([
					{ last_error: null },
				]);
			}),
		);
	} finally {
		await runtime.dispose();
		fixture.cleanup();
	}
});

it("coalesces missed intervals, deduplicates webhook events and scopes mutations", async () => {
	const fixture = makeFixture();
	const runtime = fixture.open();
	try {
		await runtime.runPromise(fixture.seed);
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* fixture.service;
				yield* service.create({
					sessionId,
					clientRequestId: "interval",
					title: "Check",
					prompt: "recurring",
					schedule: { kind: "interval", everyMs: 60_000, startAt: 0 },
				});
				const hook = yield* service.create({
					sessionId,
					clientRequestId: "hook",
					title: "Hook",
					prompt: "webhook",
					schedule: { kind: "webhook" },
				});
				yield* service.trigger(sessionId, hook.id, "event-1");
				yield* service.trigger(sessionId, hook.id, "event-1");
				expect(
					(yield* Effect.result(
						service.update({
							sessionId: SessionId.make("other"),
							taskId: hook.id,
							enabled: false,
						}),
					))._tag,
				).toBe("Failure");
				yield* fixture.sweep;
				yield* fixture.sweep;
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT prompt FROM delivered ORDER BY prompt`,
				).toEqual([{ prompt: "recurring" }, { prompt: "webhook" }]);
				yield* service.trigger(sessionId, hook.id, "event-2");
				yield* service.update({ sessionId, taskId: hook.id, enabled: false });
				yield* fixture.sweep;
				expect((yield* sql`SELECT * FROM delivered`).length).toBe(2);
			}),
		);
	} finally {
		await runtime.dispose();
		fixture.cleanup();
	}
});

it("stores secrets outside SQL, scopes environment bindings and rejects reserved variables", async () => {
	const fixture = makeFixture();
	const runtime = fixture.open();
	try {
		await runtime.runPromise(fixture.seed);
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* fixture.service;
				const input = {
					sessionId,
					clientRequestId: "secret",
					label: "API token",
					reason: "Run integration",
					environmentVariable: "TEST_API_TOKEN",
				};
				const request = yield* service.requestSecret(input);
				expect((yield* service.requestSecret(input)).id).toBe(request.id);
				expect(
					(yield* Effect.result(
						service.respondSecret(SessionId.make("other"), request.id, "wrong"),
					))._tag,
				).toBe("Failure");
				const response = yield* service.respondSecret(
					sessionId,
					request.id,
					"private-value-123",
				);
				expect(response.status).toBe("provided");
				expect(JSON.stringify(response)).not.toContain("private-value-123");
				expect(yield* service.secretBindings(sessionId)).toEqual({
					TEST_API_TOKEN: "private-value-123",
				});
				expect(yield* service.secretBindings(SessionId.make("other"))).toEqual(
					{},
				);
				expect(
					(yield* Effect.result(
						service.requestSecret({
							...input,
							clientRequestId: "reserved",
							environmentVariable: "NODE_OPTIONS",
						}),
					))._tag,
				).toBe("Failure");
				const sql = yield* SqlClient.SqlClient;
				expect(
					JSON.stringify(yield* sql`SELECT * FROM secret_requests`),
				).not.toContain("private-value-123");
				expect(yield* service.respondSecret(sessionId, request.id)).toEqual(
					response,
				);
			}),
		);
	} finally {
		await runtime.dispose();
		fixture.cleanup();
	}
});

it("rolls back queued admission when cancellation wins after pending delivery was read", async () => {
	const fixture = makeFixture();
	const runtime = fixture.open();
	try {
		await runtime.runPromise(fixture.seed);
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* fixture.service;
				const sql = yield* SqlClient.SqlClient;
				const task = yield* service.create({
					sessionId,
					clientRequestId: "race",
					title: "Race",
					prompt: "cancel me",
					schedule: { kind: "once", at: 0 },
				});
				yield* service.sweep((_session, commandId, prompt, committed) =>
					Effect.gen(function* () {
						yield* service.remove(sessionId, task.id);
						yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`INSERT INTO delivered VALUES (${commandId}, ${prompt})`;
								yield* committed;
							}),
						);
					}),
				);
				expect(yield* sql`SELECT * FROM delivered`).toEqual([]);
			}),
		);
	} finally {
		await runtime.dispose();
		fixture.cleanup();
	}
});

it("does not let archived sessions starve deliverable schedules", async () => {
	const fixture = makeFixture();
	const runtime = fixture.open();
	try {
		await runtime.runPromise(fixture.seed);
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* fixture.service;
				const sql = yield* SqlClient.SqlClient;
				const blocked = yield* service.create({
					sessionId: SessionId.make("other"),
					clientRequestId: "blocked",
					title: "Archived",
					prompt: "blocked",
					schedule: { kind: "webhook" },
				});
				for (let i = 0; i < 101; i++)
					yield* service.trigger(
						SessionId.make("other"),
						blocked.id,
						String(i),
					);
				yield* sql`UPDATE sessions SET archived_at = '2026' WHERE id = 'other'`;
				yield* service.create({
					sessionId,
					clientRequestId: "healthy",
					title: "Healthy",
					prompt: "healthy",
					schedule: { kind: "once", at: 0 },
				});
				yield* fixture.sweep;
				expect(yield* sql`SELECT prompt FROM delivered`).toEqual([
					{ prompt: "healthy" },
				]);
			}),
		);
	} finally {
		await runtime.dispose();
		fixture.cleanup();
	}
});

it("rebinds schedule edits to their attested author and rejects another author’s retry key", async () => {
	const fixture = makeFixture();
	const runtime = fixture.open();
	try {
		await runtime.runPromise(fixture.seed);
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* fixture.service;
				const actor = {
					subject: "verified-user",
					membershipId: "verified-membership",
				};
				const task = yield* service.create(
					{
						sessionId,
						clientRequestId: "actor",
						title: "Actor",
						prompt: "run",
						schedule: { kind: "once", at: 0 },
					},
					actor,
				);
				const editor = {
					subject: "verified-editor",
					membershipId: "editor-membership",
				};
				expect(
					(yield* Effect.result(
						service.create(
							{
								sessionId,
								clientRequestId: "actor",
								title: "Actor",
								prompt: "run",
								schedule: { kind: "once", at: 0 },
							},
							editor,
						),
					))._tag,
				).toBe("Failure");
				yield* service.update(
					{
						sessionId,
						taskId: task.id,
						prompt: "updated",
					},
					editor,
				);
				let seen: unknown;
				yield* service.sweep(
					(_session, _commandId, _prompt, committed, queuedActor) => {
						seen = queuedActor;
						return committed;
					},
				);
				expect(seen).toEqual(editor);
			}),
		);
	} finally {
		await runtime.dispose();
		fixture.cleanup();
	}
});

it("rolls back an old-author admission if an editor rebinds the schedule during delivery", async () => {
	const fixture = makeFixture();
	const runtime = fixture.open();
	try {
		await runtime.runPromise(fixture.seed);
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* fixture.service;
				const sql = yield* SqlClient.SqlClient;
				const task = yield* service.create(
					{
						sessionId,
						clientRequestId: "author-race",
						title: "Actor",
						prompt: "run",
						schedule: { kind: "once", at: 0 },
					},
					{ subject: "creator", membershipId: "creator-membership" },
				);
				yield* service.sweep((_session, commandId, prompt, committed) =>
					Effect.gen(function* () {
						yield* service.update(
							{ sessionId, taskId: task.id, title: "Edited" },
							{ subject: "editor", membershipId: "editor-membership" },
						);
						yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`INSERT INTO delivered VALUES (${commandId}, ${prompt})`;
								yield* committed;
							}),
						);
					}),
				);
				expect(yield* sql`SELECT * FROM delivered`).toEqual([]);
			}),
		);
	} finally {
		await runtime.dispose();
		fixture.cleanup();
	}
});

it("retries an edited pending prompt once without changing already admitted work", async () => {
	const fixture = makeFixture();
	const runtime = fixture.open();
	try {
		await runtime.runPromise(fixture.seed);
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* fixture.service;
				const sql = yield* SqlClient.SqlClient;
				const actor = {
					subject: "creator",
					membershipId: "creator-membership",
				};
				const task = yield* service.create(
					{
						sessionId,
						clientRequestId: "prompt-race",
						title: "Prompt",
						prompt: "old prompt",
						schedule: { kind: "once", at: 0 },
					},
					actor,
				);
				yield* service.sweep((_session, commandId, prompt, committed) =>
					Effect.gen(function* () {
						yield* service.update(
							{ sessionId, taskId: task.id, prompt: "edited prompt" },
							actor,
						);
						yield* sql.withTransaction(
							Effect.gen(function* () {
								yield* sql`INSERT INTO delivered VALUES (${commandId}, ${prompt})`;
								yield* committed;
							}),
						);
					}),
				);
				expect(yield* sql`SELECT * FROM delivered`).toEqual([]);
				yield* sql`UPDATE scheduled_task_deliveries SET retry_after = 0`;
				yield* fixture.sweep;
				yield* fixture.sweep;
				expect(yield* sql`SELECT prompt FROM delivered`).toEqual([
					{ prompt: "edited prompt" },
				]);
				yield* service.update(
					{ sessionId, taskId: task.id, prompt: "future prompt" },
					actor,
				);
				expect(
					yield* sql`SELECT prompt FROM scheduled_task_deliveries WHERE delivered_at IS NOT NULL`,
				).toEqual([{ prompt: "edited prompt" }]);
				expect(yield* sql`SELECT prompt FROM delivered`).toEqual([
					{ prompt: "edited prompt" },
				]);
			}),
		);
	} finally {
		await runtime.dispose();
		fixture.cleanup();
	}
});
