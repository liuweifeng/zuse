import { translateCodexItem } from "@zuse/agents/drivers/codex";
import type { Thread } from "@zuse/agents/drivers/codex/generated/v2/Thread";
import { withCodexControlClient } from "@zuse/agents/drivers/codex-control-client";
import {
	codexTurnRequiresChildRecovery,
	readCodexThread,
} from "@zuse/agents/drivers/codex-thread-reader";
import {
	AgentItemId,
	type MessageContent,
	MessageId,
	ProviderTurnReference,
	type SessionId,
	SessionStartError,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { eventToContent } from "./conversation-message-mapping.ts";
import { redactRecoveryContent } from "./provider-turn-recovery.ts";

export const inspectNativeChildThread = (
	threadId: string,
): Effect.Effect<Thread, Error> =>
	Effect.tryPromise({
		try: () =>
			withCodexControlClient(null, (client) =>
				readCodexThread(client, threadId),
			),
		catch: () => new Error("Native child transcript is unavailable."),
	});

/** Only complete native evidence is portable. Summaries are never substitutes for a child transcript. */
export const prepareNativeChildTranscript = (
	thread: Thread,
	parentThreadId: string,
) => {
	const origin =
		typeof thread.source === "object" && "subAgent" in thread.source
			? thread.source.subAgent
			: null;
	if (
		origin === null ||
		typeof origin !== "object" ||
		!("thread_spawn" in origin) ||
		origin.thread_spawn.parent_thread_id !== parentThreadId
	)
		throw new Error("Native child lineage could not be verified.");
	if (thread.status.type !== "idle" && thread.status.type !== "notLoaded")
		throw new Error("Native child is not idle.");
	if (thread.turns.length === 0)
		throw new Error("Native child transcript is empty.");
	const messages: { id: MessageId; content: MessageContent }[] = [];
	for (const turn of thread.turns) {
		if (
			turn.itemsView !== "full" ||
			turn.status !== "completed" ||
			codexTurnRequiresChildRecovery(turn)
		)
			throw new Error(
				"Native child transcript is incomplete or contains unverified nested work.",
			);
		for (const item of turn.items) {
			const identity = `native-child:${thread.id}:${turn.id}:${item.id}`;
			const add = (suffix: string, content: MessageContent) =>
				messages.push({
					id: MessageId.make(`${identity}:${suffix}`),
					content: redactRecoveryContent(content),
				});
			if (item.type === "userMessage") {
				if (item.content.some((part) => part.type !== "text"))
					throw new Error(
						"Native child non-text input cannot be copied faithfully.",
					);
				add("user", {
					_tag: "user",
					text: item.content
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("\n"),
				});
				continue;
			}
			if (item.type === "agentMessage") {
				add("assistant", {
					_tag: "assistant",
					itemId: AgentItemId.make(item.id),
					text: item.text,
					checkpoint: { revision: Number.MAX_SAFE_INTEGER, final: true },
				});
				continue;
			}
			const mapped = new Map<string, MessageContent>();
			for (const phase of ["started", "completed"] as const)
				for (const event of translateCodexItem(item, phase)) {
					const content = eventToContent(event);
					if (content !== null) mapped.set(content._tag, content);
				}
			if (mapped.size === 0)
				throw new Error(
					`Native child item ${item.type} cannot be copied faithfully.`,
				);
			for (const [tag, content] of mapped) add(tag, content);
		}
	}
	if (
		!messages.some((message) => message.content._tag === "user") ||
		!messages.some((message) => message.content._tag === "assistant")
	)
		throw new Error("Native child transcript lacks complete input and output.");
	return messages;
};

export const captureNativeChildFork = (
	sql: SqlClient.SqlClient,
	sourceSessionId: SessionId,
	stepId: string,
	inspect = inspectNativeChildThread,
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			native_child_id: string | null;
			status: string;
			kind: string;
			provider_turn_json: string | null;
		}>`SELECT s.native_child_id,s.status,s.kind,a.provider_turn_json FROM session_execution_steps s JOIN session_attempts a ON a.session_id=s.session_id AND a.id=s.attempt_id AND a.turn_id=s.turn_id WHERE s.session_id=${sourceSessionId} AND s.id=${stepId}`;
		const step = rows[0];
		if (
			step === undefined ||
			step.kind !== "subagent" ||
			step.status !== "completed" ||
			step.native_child_id === null ||
			step.provider_turn_json === null
		)
			return yield* Effect.fail(
				new Error(
					"A completed native child with recorded execution identity is required.",
				),
			);
		const reference = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(ProviderTurnReference),
		)(step.provider_turn_json);
		if (reference.provider !== "codex")
			return yield* Effect.fail(
				new Error(
					"Native child transcript forks are unavailable for this provider.",
				),
			);
		const thread = yield* inspect(step.native_child_id);
		if (thread.id !== step.native_child_id)
			return yield* Effect.fail(
				new Error("Native child transcript identity does not match."),
			);
		return yield* Effect.try(() =>
			prepareNativeChildTranscript(thread, reference.nativeThreadId),
		);
	}).pipe(
		Effect.mapError(
			(error) =>
				new SessionStartError({
					providerId: "codex",
					reason:
						error instanceof Error
							? error.message
							: "Native child transcript could not be verified.",
				}),
		),
	);
