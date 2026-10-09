import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { SessionId } from "./session.ts";

const ShortText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(200),
);
const TaskText = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(100_000),
);
const Timestamp = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
);
export const TaskSchedule = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("once"), at: Timestamp }),
	Schema.Struct({
		kind: Schema.Literal("interval"),
		everyMs: Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(60_000),
		),
		startAt: Schema.optional(Timestamp),
	}),
	Schema.Struct({ kind: Schema.Literal("webhook") }),
]);
export type TaskSchedule = typeof TaskSchedule.Type;
export const ScheduledTask = Schema.Struct({
	id: Schema.String,
	sessionId: SessionId,
	title: Schema.String,
	prompt: Schema.String,
	schedule: TaskSchedule,
	enabled: Schema.Boolean,
	nextRunAt: Schema.NullOr(Timestamp),
	lastRunAt: Schema.NullOr(Timestamp),
	lastError: Schema.NullOr(Schema.String),
	createdAt: Timestamp,
});
export type ScheduledTask = typeof ScheduledTask.Type;
export const ScheduledTaskCreate = Schema.Struct({
	sessionId: SessionId,
	clientRequestId: ShortText,
	title: ShortText,
	prompt: TaskText,
	schedule: TaskSchedule,
});
export type ScheduledTaskCreate = typeof ScheduledTaskCreate.Type;
export const ScheduledTaskUpdate = Schema.Struct({
	sessionId: SessionId,
	taskId: Schema.String,
	title: Schema.optional(ShortText),
	prompt: Schema.optional(TaskText),
	schedule: Schema.optional(TaskSchedule),
	enabled: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskUpdate = typeof ScheduledTaskUpdate.Type;
export class AutomationError extends Schema.TaggedErrorClass<AutomationError>()(
	"AutomationError",
	{ message: Schema.String },
) {}
const EnvName = Schema.String.check(
	Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
);
export const SecretRequest = Schema.Struct({
	id: Schema.String,
	sessionId: SessionId,
	label: Schema.String,
	reason: Schema.String,
	environmentVariable: EnvName,
	status: Schema.Literals(["pending", "provided", "cancelled"]),
	reference: Schema.NullOr(Schema.String),
	createdAt: Timestamp,
});
export type SecretRequest = typeof SecretRequest.Type;
export const SecretRequestCreate = Schema.Struct({
	sessionId: SessionId,
	clientRequestId: ShortText,
	label: ShortText,
	reason: Schema.String.check(Schema.isMaxLength(2000)),
	environmentVariable: EnvName,
});
export type SecretRequestCreate = typeof SecretRequestCreate.Type;
export const ScheduleCreateRpc = Rpc.make("schedule.create", {
	payload: ScheduledTaskCreate,
	success: ScheduledTask,
	error: AutomationError,
});
export const ScheduleListRpc = Rpc.make("schedule.list", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Array(ScheduledTask),
	error: AutomationError,
});
export const ScheduleUpdateRpc = Rpc.make("schedule.update", {
	payload: ScheduledTaskUpdate,
	success: ScheduledTask,
	error: AutomationError,
});
export const ScheduleDeleteRpc = Rpc.make("schedule.delete", {
	payload: Schema.Struct({ sessionId: SessionId, taskId: Schema.String }),
	success: Schema.Void,
	error: AutomationError,
});
// Webhook producers authenticate using the same workspace RPC transport. No anonymous listener.
export const ScheduleTriggerRpc = Rpc.make("schedule.trigger", {
	payload: Schema.Struct({
		sessionId: SessionId,
		taskId: Schema.String,
		eventId: ShortText,
	}),
	success: Schema.Void,
	error: AutomationError,
});
export const SecretRequestRpc = Rpc.make("secrets.request", {
	payload: SecretRequestCreate,
	success: SecretRequest,
	error: AutomationError,
});
export const SecretListRpc = Rpc.make("secrets.list", {
	payload: Schema.Struct({ sessionId: SessionId }),
	success: Schema.Array(SecretRequest),
	error: AutomationError,
});
export const SecretRespondRpc = Rpc.make("secrets.respond", {
	payload: Schema.Struct({
		sessionId: SessionId,
		requestId: Schema.String,
		value: Schema.optional(
			Schema.Redacted(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
			),
		),
	}),
	success: SecretRequest,
	error: AutomationError,
});
