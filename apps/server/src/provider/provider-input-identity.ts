import type { ProviderSessionHandle } from "@zuse/agents/kernel/driver";
import { AgentItemId } from "@zuse/contracts";
import { Effect, Stream } from "effect";

/** Native callback IDs are references, not application authority across acquisitions. */
export const ownProviderInputs = (
	handle: ProviderSessionHandle,
): ProviderSessionHandle => {
	const byNative = new Map<string, AgentItemId>();
	const byPublic = new Map<
		AgentItemId,
		{ nativeId: AgentItemId; kind: "question" | "plan" }
	>();
	const respond = handle.respondToPlan;
	// Retain bounded result correlation after callback authority is released.
	const settledPlans = new Map<AgentItemId, AgentItemId>();
	const nativeKey = (kind: "question" | "plan", id: AgentItemId) =>
		`${kind}:${id}`;
	const bind = (kind: "question" | "plan", nativeId: AgentItemId) => {
		const key = nativeKey(kind, nativeId);
		let id = byNative.get(key);
		if (id === undefined) {
			if (kind === "plan") settledPlans.delete(nativeId);
			id = AgentItemId.make(`${kind}:${crypto.randomUUID()}`);
			byNative.set(key, id);
			byPublic.set(id, { nativeId, kind });
		}
		return id;
	};
	let closed = false;
	const cancel = handle.cancelQuestion;
	const forget = (publicId: AgentItemId) => {
		const entry = byPublic.get(publicId);
		if (entry === undefined) return;
		const key = nativeKey(entry.kind, entry.nativeId);
		byPublic.delete(publicId);
		if (byNative.get(key) === publicId) byNative.delete(key);
	};
	const invoke = (
		publicId: AgentItemId,
		kind: "question" | "plan",
		callback: (nativeId: AgentItemId) => Effect.Effect<void, Error>,
	) =>
		Effect.suspend(() => {
			const entry = byPublic.get(publicId);
			return closed || entry === undefined || entry.kind !== kind
				? Effect.fail(new Error("Input callback is no longer available"))
				: callback(entry.nativeId);
		});
	return {
		...handle,
		events: handle.events.pipe(
			Stream.map((event) => {
				if (event._tag === "UserQuestion") {
					if (closed) return null;
					const publicId = bind("question", event.itemId);
					return { ...event, itemId: publicId };
				}
				if (
					event._tag === "QuestionCallbackReleased" ||
					event._tag === "UserQuestionResolved"
				) {
					const publicId = byNative.get(nativeKey("question", event.itemId));
					if (publicId === undefined) return null;
					forget(publicId);
					return { ...event, itemId: publicId };
				}
				if (respond !== undefined) {
					if (event._tag === "ToolUse" && event.tool === "ExitPlanMode") {
						if (closed) return null;
						return { ...event, itemId: bind("plan", event.itemId) };
					}
					if (event._tag === "PlanApprovalRequested") {
						if (closed) return null;
						return { ...event, toolCallId: bind("plan", event.toolCallId) };
					}
					if (event._tag === "ToolResult") {
						const id = byNative.get(nativeKey("plan", event.itemId));
						if (id !== undefined) {
							forget(id);
							settledPlans.set(event.itemId, id);
							if (settledPlans.size > 2048) {
								const oldest = settledPlans.keys().next().value;
								if (oldest !== undefined) settledPlans.delete(oldest);
							}
							return { ...event, itemId: id };
						}
						const settled = settledPlans.get(event.itemId);
						if (settled !== undefined) return { ...event, itemId: settled };
					}
				}

				return event;
			}),
			Stream.filter((event) => event !== null),
		),
		answerQuestion: (itemId, answers) =>
			invoke(itemId, "question", (nativeId) =>
				handle.answerQuestion(nativeId, answers),
			),
		cancelQuestion:
			cancel === undefined
				? undefined
				: (itemId) => invoke(itemId, "question", cancel),
		acknowledgeQuestionAnswer: (itemId) =>
			Effect.suspend(() => {
				const entry = byPublic.get(itemId);
				if (entry === undefined || entry.kind !== "question" || closed)
					return Effect.void;
				// Revoke before yielding: a late receipt cannot acknowledge a replacement.
				forget(itemId);
				return (
					handle.acknowledgeQuestionAnswer?.(entry.nativeId) ?? Effect.void
				);
			}),
		respondToPlan:
			respond === undefined
				? undefined
				: (itemId, outcome, feedback) =>
						invoke(itemId, "plan", (nativeId) =>
							respond(nativeId, outcome, feedback),
						),

		close: () =>
			Effect.suspend(() => {
				closed = true;
				byNative.clear();
				byPublic.clear();
				settledPlans.clear();
				return handle.close();
			}),
	};
};
