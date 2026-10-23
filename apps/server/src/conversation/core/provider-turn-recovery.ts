import { translateCodexItem } from "@zuse/agents/drivers/codex";
import { withCodexControlClient } from "@zuse/agents/drivers/codex-control-client";
import {
	type CodexTurnEvidence,
	codexTurnRequiresChildRecovery,
	readCodexTurnEvidence,
} from "@zuse/agents/drivers/codex-thread-reader";
import {
	AgentTurnId,
	MessageContent,
	MessageId,
	type ProviderTurnReference,
	SessionId,
} from "@zuse/contracts";
import type { Job } from "@zuse/domain/agent-engine/jobs";
import type { AttemptOwnership } from "@zuse/domain/engine/dispatch";
import { Effect, Schema } from "effect";
import { redactSecretText } from "../../security/secret-redaction.ts";
import {
	eventToContent,
	providerMessageId,
} from "./conversation-message-mapping.ts";
import type { ProviderJobExecutorOptions } from "./provider-jobs.ts";

const redactValue = (value: unknown, depth = 0): unknown => {
	if (depth > 100)
		throw new Error("Transcript structure exceeds supported depth");
	if (typeof value === "string") return redactSecretText(value);
	if (Array.isArray(value))
		return value.map((entry) => redactValue(entry, depth + 1));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			/^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credentials?)$/i.test(
				key,
			)
				? "[REDACTED]"
				: redactValue(entry, depth + 1),
		]),
	);
};

export const redactRecoveryContent = (
	content: MessageContent,
): MessageContent => {
	const redacted = Schema.decodeUnknownSync(MessageContent)(
		redactValue(content),
	);
	return "itemId" in content &&
		content.itemId !== undefined &&
		"itemId" in redacted
		? { ...redacted, itemId: content.itemId }
		: redacted;
};

export const inspectNativeTurn = (
	reference: ProviderTurnReference,
): Effect.Effect<CodexTurnEvidence, Error> =>
	reference.provider !== "codex"
		? Effect.fail(new Error("Native recovery is unavailable for this provider"))
		: Effect.tryPromise({
				try: () =>
					withCodexControlClient(null, (client) =>
						readCodexTurnEvidence(client, reference),
					),
				catch: () => new Error("Native execution could not be inspected"),
			});

const prepareBackfill = (
	evidence: Extract<CodexTurnEvidence, { kind: "terminal" }>,
	sourceAttemptId: string,
) => {
	const messages: { id: MessageId; content: MessageContent }[] = [];
	for (const item of evidence.turn.items) {
		if (item.type === "userMessage") continue;
		for (const phase of ["started", "completed"] as const) {
			for (const event of translateCodexItem(item, phase)) {
				const mapped = eventToContent(event);
				if (
					mapped === null ||
					!("itemId" in event) ||
					typeof event.itemId !== "string"
				)
					continue;
				messages.push({
					id: providerMessageId(
						sourceAttemptId,
						`${event._tag}:${event.itemId}`,
					),
					content: redactRecoveryContent(
						mapped._tag === "assistant" || mapped._tag === "thinking"
							? {
									...mapped,
									checkpoint: {
										revision: Number.MAX_SAFE_INTEGER,
										final: true,
									},
								}
							: mapped,
					),
				});
			}
		}
	}
	if (evidence.turn.error !== null)
		messages.push({
			id: MessageId.make(`recovery:${sourceAttemptId}:provider-error`),
			content: redactRecoveryContent({
				_tag: "error",
				message: evidence.turn.error.message,
			}),
		});
	return messages;
};

/** Recovery uses the original execution's message identities but the new attempt's write authority. */
export const recoverProviderTurn = (
	job: Job,
	options: Pick<
		ProviderJobExecutorOptions,
		"sessionDomain" | "persistMessage" | "ndjsonAppend" | "settleTurn"
	>,
	inspect: typeof inspectNativeTurn = inspectNativeTurn,
) =>
	Effect.gen(function* () {
		const request = job.request;
		if (request._tag !== "provider.turn.recover") return;
		const sessionId = SessionId.make(job.sessionId);
		const turnId = AgentTurnId.make(request.turnId);
		const ownership: AttemptOwnership = {
			requireUninterrupted: true,
			turnId,
			attemptId: request.attemptId,
		};
		const active = yield* options.sessionDomain.activeAttempt(sessionId);
		if (active?.turnId !== turnId || active.attemptId !== ownership.attemptId)
			return;
		const inspected = yield* inspect(request.reference).pipe(
			Effect.catch(() => Effect.succeed(null)),
		);

		const evidence: CodexTurnEvidence | null =
			inspected?.kind === "terminal" &&
			codexTurnRequiresChildRecovery(inspected.turn)
				? { kind: "incomplete", reason: "native_children" }
				: inspected;
		const prepared =
			evidence?.kind === "terminal"
				? yield* Effect.try({
						try: () => prepareBackfill(evidence, request.sourceAttemptId),
						catch: () => new Error("Invalid native transcript"),
					}).pipe(Effect.catch(() => Effect.succeed(null)))
				: null;
		if (evidence?.kind !== "terminal" || prepared === null) {
			const message =
				evidence?.kind === "incomplete" && evidence.reason === "native_children"
					? "Recovery could not reconstruct exact native child execution output. Parent completion does not prove child completion. The prompt was not resent; review the provider's child sessions before retrying."
					: evidence?.kind === "running"
						? "The provider still reports this execution as running. Recovery did not resend the prompt. Review its native session before retrying."
						: "Recovery could not verify a complete native result. The prompt was not resent. Review the provider session before retrying.";
			const persisted = yield* options.persistMessage(
				sessionId,
				{ _tag: "error", message },
				MessageId.make(`recovery:${request.attemptId}:uncertain`),
				turnId,
				ownership,
			);
			if (persisted.changed !== false)
				yield* options.ndjsonAppend(sessionId, persisted);
			yield* options.settleTurn(sessionId, turnId, "error", ownership);
			return;
		}
		for (const { id, content } of prepared) {
			const persisted = yield* options.persistMessage(
				sessionId,
				content,
				id,
				turnId,
				ownership,
			);
			if (persisted.changed !== false)
				yield* options.ndjsonAppend(sessionId, persisted);
		}

		yield* options.settleTurn(
			sessionId,
			turnId,
			evidence.turn.status === "failed" ? "error" : evidence.turn.status,
			ownership,
		);
	});
