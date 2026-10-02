import type { ProviderSessionHandle } from "@zuse/agents/kernel/driver";
import { AgentItemId } from "@zuse/contracts";
import { Effect, Stream } from "effect";

/** Native callback IDs are references, not application authority across acquisitions. */
export const ownProviderQuestions = (
	handle: ProviderSessionHandle,
): ProviderSessionHandle => {
	const byNative = new Map<AgentItemId, AgentItemId>();
	const byPublic = new Map<AgentItemId, AgentItemId>();
	let closed = false;
	const cancel = handle.cancelQuestion;
	const forget = (publicId: AgentItemId) => {
		const nativeId = byPublic.get(publicId);
		if (nativeId === undefined) return;
		byPublic.delete(publicId);
		if (byNative.get(nativeId) === publicId) byNative.delete(nativeId);
	};
	const invoke = (
		publicId: AgentItemId,
		callback: (nativeId: AgentItemId) => Effect.Effect<void, Error>,
	) =>
		Effect.suspend(() => {
			const nativeId = byPublic.get(publicId);
			return closed || nativeId === undefined
				? Effect.fail(new Error("Question callback is no longer available"))
				: callback(nativeId);
		});
	return {
		...handle,
		events: handle.events.pipe(
			Stream.map((event) => {
				if (event._tag === "UserQuestion") {
					if (closed) return null;
					let publicId = byNative.get(event.itemId);
					if (publicId === undefined) {
						publicId = AgentItemId.make(`question:${crypto.randomUUID()}`);
						byNative.set(event.itemId, publicId);
						byPublic.set(publicId, event.itemId);
					}
					return { ...event, itemId: publicId };
				}
				if (
					event._tag === "QuestionCallbackReleased" ||
					event._tag === "UserQuestionResolved"
				) {
					const publicId = byNative.get(event.itemId);
					if (publicId === undefined) return null;
					forget(publicId);
					return { ...event, itemId: publicId };
				}
				return event;
			}),
			Stream.filter((event) => event !== null),
		),
		answerQuestion: (itemId, answers) =>
			invoke(itemId, (nativeId) => handle.answerQuestion(nativeId, answers)),
		cancelQuestion:
			cancel === undefined ? undefined : (itemId) => invoke(itemId, cancel),
		acknowledgeQuestionAnswer: (itemId) =>
			Effect.suspend(() => {
				const nativeId = byPublic.get(itemId);
				if (nativeId === undefined || closed) return Effect.void;
				// Revoke before yielding: a late receipt cannot acknowledge a replacement.
				forget(itemId);
				return handle.acknowledgeQuestionAnswer?.(nativeId) ?? Effect.void;
			}),
		close: () =>
			Effect.suspend(() => {
				closed = true;
				byNative.clear();
				byPublic.clear();
				return handle.close();
			}),
	};
};
