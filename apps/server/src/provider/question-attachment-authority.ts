import {
	userQuestionAnswerKey,
	validateUserQuestionAnswers,
} from "@zuse/agents/kernel/user-question-answer";
import {
	type AgentItemId,
	type AgentSessionId,
	AgentSessionNotFoundError,
	type QuestionAttachment,
	type UserQuestion,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { structuralTupleKey } from "@zuse/utils/structural-tuple-key";
import { type Duration, Effect } from "effect";
import {
	type InputCallbackDelivery,
	makeInputCallbackDelivery,
} from "./input-callback-delivery.ts";

type AttachmentEntry<DeliveryError> = {
	readonly attachment: QuestionAttachment;
	readonly questions: ReadonlyArray<UserQuestion>;
	readonly questionKey: string;
	readonly delivery: InputCallbackDelivery<
		AgentSessionNotFoundError | DeliveryError
	>;
};

type QuestionAttachmentAuthorityOptions = {
	readonly maxEntries?: number;
	readonly deliveryTimeout?: Duration.Input;
};

const DEFAULT_MAX_QUESTION_ATTACHMENTS = 2_048;
const DEFAULT_QUESTION_DELIVERY_TIMEOUT = "30 seconds";

export type QuestionAttachmentAdmission =
	| "attached"
	| "duplicate"
	| "conflict"
	| "full";

/**
 * Process-local authority for provider-owned question callbacks.
 *
 * The delivered answer key deliberately lives only in memory: it makes a
 * post-provider/pre-database retry idempotent in the same process. Across a
 * restart, the provider boundary allocates fresh application question IDs;
 * a durable receipt cannot authorize a replacement callback.
 */
export const makeQuestionAttachmentAuthority = <DeliveryError = never>(
	options: QuestionAttachmentAuthorityOptions = {},
) => {
	const configuredMax = options.maxEntries ?? DEFAULT_MAX_QUESTION_ATTACHMENTS;
	const maxEntries =
		Number.isSafeInteger(configuredMax) && configuredMax > 0
			? configuredMax
			: DEFAULT_MAX_QUESTION_ATTACHMENTS;
	const deliveryTimeout =
		options.deliveryTimeout ?? DEFAULT_QUESTION_DELIVERY_TIMEOUT;
	const entries = new Map<string, AttachmentEntry<DeliveryError>>();
	const keyOf = (sessionId: AgentSessionId, itemId: AgentItemId): string =>
		structuralTupleKey(sessionId, itemId);
	const answerDeliveryKey = (
		answers: ReadonlyArray<UserQuestionAnswer>,
	): string => structuralTupleKey("answer", userQuestionAnswerKey(answers));
	const cancellationDeliveryKey = structuralTupleKey("cancel");
	const questionKey = (questions: ReadonlyArray<UserQuestion>): string =>
		JSON.stringify(
			questions.map((question) => [
				question.question,
				question.options,
				question.multiSelect === true,
			]),
		);
	const missingAttachment = (sessionId: AgentSessionId) =>
		new AgentSessionNotFoundError({ sessionId });
	const revoke = (key: string, entry: AttachmentEntry<DeliveryError>) => {
		entries.delete(key);
		entry.delivery.revoke();
	};
	const isValidAnswer = (
		entry: AttachmentEntry<DeliveryError>,
		answers: ReadonlyArray<UserQuestionAnswer>,
	): boolean =>
		validateUserQuestionAnswers(entry.questions, answers) === undefined;
	const deliverWithKey = <R>(
		sessionId: AgentSessionId,
		itemId: AgentItemId,
		deliveryKey: string,
		invokeProvider: Effect.Effect<void, DeliveryError, R>,
		validateEntry: (entry: AttachmentEntry<DeliveryError>) => boolean,
	): Effect.Effect<void, AgentSessionNotFoundError | DeliveryError, R> =>
		Effect.suspend(() => {
			const entry = entries.get(keyOf(sessionId, itemId));
			if (entry === undefined || !validateEntry(entry))
				return Effect.fail(missingAttachment(sessionId));
			return entry.delivery.run(deliveryKey, invokeProvider);
		});

	return {
		attach: (
			attachment: QuestionAttachment,
			questions: ReadonlyArray<UserQuestion>,
		): QuestionAttachmentAdmission => {
			const key = keyOf(attachment.sessionId, attachment.itemId);
			const nextQuestionKey = questionKey(questions);
			const existing = entries.get(key);
			if (existing !== undefined) {
				return existing.questionKey === nextQuestionKey
					? "duplicate"
					: "conflict";
			}
			if (entries.size >= maxEntries) return "full";
			const entry: AttachmentEntry<DeliveryError> = {
				attachment,
				questions,
				questionKey: nextQuestionKey,
				delivery: makeInputCallbackDelivery<
					AgentSessionNotFoundError | DeliveryError
				>({
					isCurrent: () => entries.get(key) === entry,
					unavailable: () => missingAttachment(attachment.sessionId),
					timeout: deliveryTimeout,
					retryFailures: true,
				}),
			};
			entries.set(key, entry);
			return "attached";
		},
		detach: (sessionId: AgentSessionId, itemId: AgentItemId): boolean => {
			const key = keyOf(sessionId, itemId);
			const entry = entries.get(key);
			if (entry === undefined) return false;
			revoke(key, entry);
			return true;
		},
		detachSession: (
			sessionId: AgentSessionId,
		): ReadonlyArray<QuestionAttachment> => {
			const detached: QuestionAttachment[] = [];
			for (const [key, entry] of entries) {
				if (entry.attachment.sessionId !== sessionId) continue;
				revoke(key, entry);
				detached.push(entry.attachment);
			}
			return detached;
		},
		has: (sessionId: AgentSessionId, itemId: AgentItemId): boolean =>
			entries.has(keyOf(sessionId, itemId)),
		snapshot: (): ReadonlyArray<QuestionAttachment> =>
			[...entries.values()].map(({ attachment }) => attachment),
		validateAnswer: (
			sessionId: AgentSessionId,
			itemId: AgentItemId,
			answers: ReadonlyArray<UserQuestionAnswer>,
		): Effect.Effect<void, AgentSessionNotFoundError> =>
			Effect.suspend(() => {
				const entry = entries.get(keyOf(sessionId, itemId));
				return entry !== undefined && isValidAnswer(entry, answers)
					? Effect.void
					: Effect.fail(missingAttachment(sessionId));
			}),
		deliverAnswer: <R>(
			sessionId: AgentSessionId,
			itemId: AgentItemId,
			answers: ReadonlyArray<UserQuestionAnswer>,
			invokeProvider: Effect.Effect<void, DeliveryError, R>,
		): Effect.Effect<void, AgentSessionNotFoundError | DeliveryError, R> =>
			deliverWithKey(
				sessionId,
				itemId,
				answerDeliveryKey(answers),
				invokeProvider,
				(entry) => isValidAnswer(entry, answers),
			),
		deliverCancellation: <R>(
			sessionId: AgentSessionId,
			itemId: AgentItemId,
			invokeProvider: Effect.Effect<void, DeliveryError, R>,
		): Effect.Effect<void, AgentSessionNotFoundError | DeliveryError, R> =>
			deliverWithKey(
				sessionId,
				itemId,
				cancellationDeliveryKey,
				invokeProvider,
				() => true,
			),
	};
};
