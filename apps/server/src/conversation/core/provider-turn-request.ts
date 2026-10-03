import {
	AgentTurnId,
	ComposerInput,
	QueuedMessageInput,
	ThreadGoalSetInput,
} from "@zuse/contracts";
import { Schema } from "effect";

export const ProviderStartRequest = Schema.Struct({
	initialPrompt: Schema.NullOr(Schema.String),
	initialTurnId: Schema.optional(Schema.NullOr(AgentTurnId)),
	modelOptionsJson: Schema.NullOr(Schema.String),
	enableSubagents: Schema.Boolean,
	forkFromResume: Schema.Boolean,
	forkSourceThreadId: Schema.optional(Schema.String),
	background: Schema.Boolean,
	postBootStatus: Schema.Literals(["idle", "running"]),
});

export type ProviderStartRequest = typeof ProviderStartRequest.Type;

export const decodeProviderStartRequest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ProviderStartRequest),
);

export const decodeProviderModelOptions = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

export const decodeProviderTurnInput = Schema.decodeUnknownEffect(
	Schema.fromJsonString(
		Schema.Struct({
			...ComposerInput.fields,
			goal: Schema.optional(ThreadGoalSetInput),
		}),
	),
);

export const decodeQueuedTurnInput = Schema.decodeUnknownEffect(
	Schema.fromJsonString(QueuedMessageInput),
);
