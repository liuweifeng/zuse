import {
	AutomationError,
	type ScheduledTask,
	type ScheduledTaskCreate,
	type ScheduledTaskUpdate,
	type SecretRequest,
	type SecretRequestCreate,
	SessionId,
	TaskSchedule,
	WorkspaceActor,
} from "@zuse/contracts";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	CredentialsService,
	type CredentialsServiceShape,
} from "../provider/services/credentials-service.ts";

interface TaskRow {
	id: string;
	session_id: string;
	title: string;
	prompt: string;
	schedule_json: string;
	actor_json: string | null;
	enabled: number;
	next_run_at: number | null;
	last_run_at: number | null;
	last_error: string | null;
	created_at: number;
	deleted_at?: number | null;
}
interface SecretRow {
	id: string;
	session_id: string;
	label: string;
	reason: string;
	environment_variable: string;
	status: "pending" | "provided" | "cancelled";
	created_at: number;
}
const taskFromRow = (row: TaskRow): ScheduledTask => ({
	id: row.id,
	sessionId: SessionId.make(row.session_id),
	title: row.title,
	prompt: row.prompt,
	schedule: Schema.decodeUnknownSync(TaskSchedule)(
		JSON.parse(row.schedule_json),
	),
	enabled: row.enabled === 1,
	nextRunAt: row.next_run_at,
	lastRunAt: row.last_run_at,
	lastError: row.last_error,
	createdAt: row.created_at,
});
const secretFromRow = (row: SecretRow): SecretRequest => ({
	id: row.id,
	sessionId: SessionId.make(row.session_id),
	label: row.label,
	reason: row.reason,
	environmentVariable: row.environment_variable,
	status: row.status,
	reference: row.status === "provided" ? `secret:${row.id}` : null,
	createdAt: row.created_at,
});
const now = DateTime.nowAsDate.pipe(Effect.map((date) => date.getTime()));
const fail = (message: string) => new AutomationError({ message });
const storageError = () =>
	fail("The automation operation could not be saved. Please retry.");
const nextAt = (schedule: TaskSchedule, timestamp: number) =>
	schedule.kind === "once"
		? schedule.at
		: schedule.kind === "interval"
			? (schedule.startAt ?? timestamp + schedule.everyMs)
			: null;
const integration = "session-secret";
const actorJson = (actor: WorkspaceActor | undefined) =>
	actor === undefined
		? null
		: JSON.stringify({
				subject: actor.subject,
				membershipId: actor.membershipId,
			});
// Secret bindings must never alter executable discovery, shell initialization, dynamic loading or runtime ownership.
export const permittedSecretVariable = (name: string) =>
	!/^(PATH|HOME|SHELL|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|ZUSE_.*|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i.test(
		name,
	);

export const makeAutomationService = (
	sql: SqlClient.SqlClient,
	credentials: Pick<
		CredentialsServiceShape,
		"getIntegration" | "setIntegration" | "listIntegrationAccounts"
	>,
) => {
	const assertSession = (sessionId: SessionId) =>
		Effect.gen(function* () {
			const rows =
				yield* sql`SELECT s.id FROM sessions s JOIN chats c ON c.id = s.chat_id WHERE s.id = ${sessionId} AND s.archived_at IS NULL AND c.archived_at IS NULL`;
			if (rows.length === 0)
				return yield* fail("This session is missing or archived.");
		});
	const readTask = (sessionId: SessionId, taskId: string) =>
		Effect.gen(function* () {
			const rows =
				yield* sql<TaskRow>`SELECT * FROM scheduled_tasks WHERE id = ${taskId} AND session_id = ${sessionId} AND deleted_at IS NULL`;
			if (rows[0] === undefined)
				return yield* fail("Scheduled task not found in this session.");
			return taskFromRow(rows[0]);
		});
	const readSecret = (sessionId: SessionId, requestId: string) =>
		Effect.gen(function* () {
			const rows =
				yield* sql<SecretRow>`SELECT * FROM secret_requests WHERE id = ${requestId} AND session_id = ${sessionId}`;
			if (rows[0] === undefined)
				return yield* fail("Secret request not found in this session.");
			return secretFromRow(rows[0]);
		});
	const create = Effect.fn("Automation.create")(
		function* (input: ScheduledTaskCreate, actor?: WorkspaceActor) {
			yield* assertSession(input.sessionId);
			const timestamp = yield* now;
			const scheduleJson = JSON.stringify(input.schedule);
			yield* sql`INSERT INTO scheduled_tasks (id, session_id, client_request_id, title, prompt, schedule_json, actor_json, next_run_at, created_at) VALUES (${crypto.randomUUID()}, ${input.sessionId}, ${input.clientRequestId}, ${input.title}, ${input.prompt}, ${scheduleJson}, ${actorJson(actor)}, ${nextAt(input.schedule, timestamp)}, ${timestamp}) ON CONFLICT(session_id, client_request_id) DO NOTHING`;
			const rows =
				yield* sql<TaskRow>`SELECT * FROM scheduled_tasks WHERE session_id = ${input.sessionId} AND client_request_id = ${input.clientRequestId}`;
			const row = rows[0];
			if (
				!row ||
				row.deleted_at != null ||
				row.prompt !== input.prompt ||
				row.title !== input.title ||
				row.schedule_json !== scheduleJson ||
				row.actor_json !== actorJson(actor)
			)
				return yield* fail(
					"This request ID already belongs to a different scheduled task.",
				);
			return taskFromRow(row);
		},
		Effect.mapError((error) =>
			error instanceof AutomationError ? error : storageError(),
		),
	);
	const list = Effect.fn("Automation.list")(function* (sessionId: SessionId) {
		return (yield* sql<TaskRow>`SELECT * FROM scheduled_tasks WHERE session_id = ${sessionId} AND deleted_at IS NULL ORDER BY created_at DESC`).map(
			taskFromRow,
		);
	}, Effect.mapError(storageError));
	const update = Effect.fn("Automation.update")(
		function* (input: ScheduledTaskUpdate, actor?: WorkspaceActor) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* assertSession(input.sessionId);
					const existing = yield* readTask(input.sessionId, input.taskId);
					const timestamp = yield* now;
					const schedule = input.schedule ?? existing.schedule;
					const next =
						input.schedule !== undefined ||
						(input.enabled === true && !existing.enabled)
							? nextAt(schedule, timestamp)
							: existing.nextRunAt;
					yield* sql`UPDATE scheduled_tasks SET title = ${input.title ?? existing.title}, prompt = ${input.prompt ?? existing.prompt}, schedule_json = ${JSON.stringify(schedule)}, actor_json = ${actorJson(actor)}, enabled = ${(input.enabled ?? existing.enabled) ? 1 : 0}, next_run_at = ${next}, last_error = NULL WHERE id = ${input.taskId} AND session_id = ${input.sessionId}`;
					if (input.prompt !== undefined)
						yield* sql`UPDATE scheduled_task_deliveries SET prompt = ${input.prompt} WHERE task_id = ${input.taskId} AND delivered_at IS NULL`;
					if (input.enabled === false)
						yield* sql`DELETE FROM scheduled_task_deliveries WHERE task_id = ${input.taskId} AND delivered_at IS NULL`;
					return yield* readTask(input.sessionId, input.taskId);
				}),
			);
		},
		Effect.mapError((error) =>
			error instanceof AutomationError ? error : storageError(),
		),
	);
	const remove = Effect.fn("Automation.remove")(function* (
		sessionId: SessionId,
		taskId: string,
	) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const timestamp = yield* now;
				yield* sql`UPDATE scheduled_tasks SET deleted_at = ${timestamp}, enabled = 0, next_run_at = NULL WHERE id = ${taskId} AND session_id = ${sessionId}`;
				yield* sql`DELETE FROM scheduled_task_deliveries WHERE task_id = ${taskId} AND delivered_at IS NULL AND EXISTS (SELECT 1 FROM scheduled_tasks WHERE id = ${taskId} AND session_id = ${sessionId})`;
			}),
		);
	}, Effect.mapError(storageError));
	const trigger = Effect.fn("Automation.trigger")(
		function* (sessionId: SessionId, taskId: string, eventId: string) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* assertSession(sessionId);
					const task = yield* readTask(sessionId, taskId);
					if (task.schedule.kind !== "webhook" || !task.enabled)
						return yield* fail(
							"This webhook task is disabled or is not a webhook.",
						);
					const timestamp = yield* now;
					yield* sql`INSERT INTO scheduled_task_deliveries (task_id, event_id, command_id, prompt, created_at) VALUES (${taskId}, ${`hook:${eventId}`}, ${crypto.randomUUID()}, ${task.prompt}, ${timestamp}) ON CONFLICT(task_id, event_id) DO NOTHING`;
				}),
			);
		},
		Effect.mapError((error) =>
			error instanceof AutomationError ? error : storageError(),
		),
	);
	const requestSecret = Effect.fn("Automation.requestSecret")(
		function* (input: SecretRequestCreate) {
			yield* assertSession(input.sessionId);
			if (!permittedSecretVariable(input.environmentVariable))
				return yield* fail(
					"That environment variable is reserved by the runtime.",
				);
			// Probe the configured credential backend; cloud implementations do not use the OS keychain.
			yield* credentials
				.listIntegrationAccounts(integration)
				.pipe(
					Effect.mapError(() =>
						fail("Private credential storage is unavailable on this machine."),
					),
				);
			const timestamp = yield* now;
			yield* sql`INSERT INTO secret_requests (id, session_id, client_request_id, label, reason, environment_variable, created_at) VALUES (${crypto.randomUUID()}, ${input.sessionId}, ${input.clientRequestId}, ${input.label}, ${input.reason}, ${input.environmentVariable}, ${timestamp}) ON CONFLICT(session_id, client_request_id) DO NOTHING`;
			const rows =
				yield* sql<SecretRow>`SELECT * FROM secret_requests WHERE session_id = ${input.sessionId} AND client_request_id = ${input.clientRequestId}`;
			const row = rows[0];
			if (
				!row ||
				row.label !== input.label ||
				row.reason !== input.reason ||
				row.environment_variable !== input.environmentVariable
			)
				return yield* fail(
					"This request ID already belongs to a different secret request.",
				);
			return secretFromRow(row);
		},
		Effect.mapError((error) =>
			error instanceof AutomationError ? error : storageError(),
		),
	);
	const listSecrets = Effect.fn("Automation.listSecrets")(function* (
		sessionId: SessionId,
	) {
		return (yield* sql<SecretRow>`SELECT * FROM secret_requests WHERE session_id = ${sessionId} ORDER BY created_at DESC`).map(
			secretFromRow,
		);
	}, Effect.mapError(storageError));
	const respondSecret = Effect.fn("Automation.respondSecret")(
		function* (sessionId: SessionId, requestId: string, value?: string) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* assertSession(sessionId);
					const request = yield* readSecret(sessionId, requestId);
					if (request.status !== "pending") return request;
					if (value !== undefined)
						yield* credentials
							.setIntegration(integration, requestId, value)
							.pipe(
								Effect.mapError(() =>
									fail("The secret could not be stored. Please retry."),
								),
							);
					yield* sql`UPDATE secret_requests SET status = ${value === undefined ? "cancelled" : "provided"} WHERE id = ${requestId} AND session_id = ${sessionId} AND status = 'pending'`;
					return yield* readSecret(sessionId, requestId);
				}),
			);
		},
		Effect.mapError((error) =>
			error instanceof AutomationError ? error : storageError(),
		),
	);
	const secretBindings = Effect.fn("Automation.secretBindings")(
		function* (sessionId: SessionId) {
			const rows =
				yield* sql<SecretRow>`SELECT * FROM secret_requests WHERE session_id = ${sessionId} AND status = 'provided' ORDER BY created_at, id`;
			const env: Record<string, string> = {};
			for (const row of rows) {
				if (!permittedSecretVariable(row.environment_variable)) continue;
				const value = yield* credentials
					.getIntegration(integration, row.id)
					.pipe(
						Effect.mapError(() =>
							fail("A session secret could not be loaded."),
						),
					);
				if (value !== null) env[row.environment_variable] = value;
			}
			return env;
		},
		Effect.mapError((error) =>
			error instanceof AutomationError ? error : storageError(),
		),
	);
	// A delivery is marked only inside the queue's own SQL transaction. Process loss cannot lose or duplicate it.
	const sweep = (
		deliver: (
			sessionId: SessionId,
			commandId: string,
			prompt: string,
			committed: Effect.Effect<void>,
			actor: WorkspaceActor | undefined,
		) => Effect.Effect<void, unknown>,
	) =>
		Effect.gen(function* () {
			const timestamp = yield* now;
			yield* sql.withTransaction(
				Effect.gen(function* () {
					const due =
						yield* sql<TaskRow>`SELECT t.* FROM scheduled_tasks t JOIN sessions s ON s.id = t.session_id JOIN chats c ON c.id = s.chat_id WHERE t.deleted_at IS NULL AND t.enabled = 1 AND t.next_run_at <= ${timestamp} AND s.archived_at IS NULL AND c.archived_at IS NULL ORDER BY t.next_run_at LIMIT 100`;
					for (const row of due) {
						const task = taskFromRow(row);
						const next =
							task.schedule.kind === "interval"
								? timestamp + task.schedule.everyMs
								: null;
						yield* sql`INSERT INTO scheduled_task_deliveries (task_id, event_id, command_id, prompt, created_at) VALUES (${task.id}, ${`timer:${task.nextRunAt}`}, ${crypto.randomUUID()}, ${task.prompt}, ${timestamp}) ON CONFLICT(task_id, event_id) DO NOTHING`;
						yield* sql`UPDATE scheduled_tasks SET next_run_at = ${next}, enabled = ${next === null ? 0 : 1} WHERE id = ${task.id}`;
					}
				}),
			);
			const pending = yield* sql<{
				task_id: string;
				session_id: string;
				command_id: string;
				prompt: string;
				actor_json: string | null;
			}>`SELECT d.task_id, t.session_id, d.command_id, d.prompt, t.actor_json FROM scheduled_task_deliveries d JOIN scheduled_tasks t ON t.id = d.task_id JOIN sessions s ON s.id = t.session_id JOIN chats c ON c.id = s.chat_id WHERE t.deleted_at IS NULL AND d.delivered_at IS NULL AND d.retry_after <= ${timestamp} AND s.archived_at IS NULL AND c.archived_at IS NULL ORDER BY d.created_at LIMIT 100`;
			for (const row of pending) {
				const sessionId = SessionId.make(row.session_id);
				yield* assertSession(sessionId).pipe(
					Effect.andThen(
						deliver(
							sessionId,
							row.command_id,
							row.prompt,
							Effect.gen(function* () {
								const marked =
									yield* sql`UPDATE scheduled_task_deliveries SET delivered_at = ${timestamp} WHERE command_id = ${row.command_id} AND prompt = ${row.prompt} AND delivered_at IS NULL AND EXISTS (SELECT 1 FROM scheduled_tasks t JOIN sessions s ON s.id = t.session_id JOIN chats c ON c.id = s.chat_id WHERE t.id = scheduled_task_deliveries.task_id AND t.actor_json IS ${row.actor_json} AND t.deleted_at IS NULL AND s.archived_at IS NULL AND c.archived_at IS NULL) RETURNING command_id`;
								if (marked.length !== 1)
									return yield* Effect.die(
										new Error(
											"Scheduled delivery was cancelled before admission.",
										),
									);
								yield* sql`UPDATE scheduled_tasks SET last_run_at = ${timestamp}, last_error = NULL WHERE id = ${row.task_id}`;
							}).pipe(Effect.orDie),
							row.actor_json === null
								? undefined
								: Schema.decodeUnknownSync(WorkspaceActor)(
										JSON.parse(row.actor_json),
									),
						),
					),
					Effect.catchCause(() =>
						Effect.gen(function* () {
							yield* sql`UPDATE scheduled_tasks SET last_error = 'Delivery is waiting for this session to become available.' WHERE id = ${row.task_id}`;
							yield* sql`UPDATE scheduled_task_deliveries SET retry_after = ${timestamp + 5000} WHERE command_id = ${row.command_id} AND delivered_at IS NULL`;
						}),
					),
				);
			}
		});
	return {
		cancelSession: (sessionId: SessionId) =>
			cancelSessionAutomation(sql, sessionId),
		create,
		list,
		update,
		remove,
		trigger,
		requestSecret,
		listSecrets,
		respondSecret,
		secretBindings,
		sweep,
	};
};
export class AutomationService extends Context.Service<
	AutomationService,
	ReturnType<typeof makeAutomationService>
>()("zuse/AutomationService") {
	static readonly layer = Layer.effect(
		AutomationService,
		Effect.gen(function* () {
			return makeAutomationService(
				yield* SqlClient.SqlClient,
				yield* CredentialsService,
			);
		}),
	);
}

/** Called inside the task cancellation transaction so descendants cannot enqueue later work. */
export const cancelSessionAutomation = (
	sql: SqlClient.SqlClient,
	sessionId: SessionId,
) =>
	Effect.gen(function* () {
		yield* sql`UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL WHERE session_id = ${sessionId}`;
		yield* sql`DELETE FROM scheduled_task_deliveries WHERE delivered_at IS NULL AND task_id IN (SELECT id FROM scheduled_tasks WHERE session_id = ${sessionId})`;
		yield* sql`UPDATE secret_requests SET status = 'cancelled' WHERE session_id = ${sessionId} AND status = 'pending'`;
	}).pipe(Effect.orDie);
