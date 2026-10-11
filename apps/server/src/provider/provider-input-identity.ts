import type { ProviderSessionHandle } from "@zuse/agents/kernel/driver";
import { AgentItemId } from "@zuse/contracts";
import { Effect, Stream } from "effect";
import {
	type InputCallbackDelivery,
	makeInputCallbackDelivery,
} from "./input-callback-delivery.ts";

/** Native callback IDs are references, not application authority across acquisitions. */
export const ownProviderInputs = (
	handle: ProviderSessionHandle,
): ProviderSessionHandle => {
	const byNative = new Map<string, AgentItemId>();
	type InputIdentity = {
		nativeId: AgentItemId;
		kind: "question" | "plan";
		delivery?: InputCallbackDelivery<Error>;
	};
	const byPublic = new Map<AgentItemId, InputIdentity>();
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
			const publicId = id;
			const entry: InputIdentity = {
				nativeId,
				kind,
				delivery:
					kind === "plan"
						? makeInputCallbackDelivery<Error>({
								isCurrent: () => !closed && byPublic.get(publicId) === entry,
								unavailable: () =>
									new Error(
										"Plan callback is unavailable or its delivery outcome is uncertain",
									),
								timeout: "30 seconds",
								retryFailures: false,
							})
						: undefined,
			};
			byPublic.set(id, entry);
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
		entry.delivery?.revoke();
		if (byNative.get(key) === publicId) byNative.delete(key);
	};
	const settlePlan = (publicId: AgentItemId) => {
		const entry = byPublic.get(publicId);
		if (entry?.kind !== "plan") return;
		forget(publicId);
		settledPlans.set(entry.nativeId, publicId);
		if (settledPlans.size > 2048) {
			const oldest = settledPlans.keys().next().value;
			if (oldest !== undefined) settledPlans.delete(oldest);
		}
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
							settlePlan(id);
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
		acknowledgePlanResponse: (itemId) =>
			Effect.suspend(() => {
				const entry = byPublic.get(itemId);
				if (closed || entry?.kind !== "plan") return Effect.void;
				settlePlan(itemId);
				return handle.acknowledgePlanResponse?.(entry.nativeId) ?? Effect.void;
			}),

		respondToPlan:
			respond === undefined
				? undefined
				: (itemId, outcome, feedback) =>
						Effect.suspend(() => {
							const entry = byPublic.get(itemId);
							if (
								closed ||
								entry?.kind !== "plan" ||
								entry.delivery === undefined
							)
								return Effect.fail(
									new Error("Plan callback is no longer available"),
								);
							return entry.delivery.run(
								JSON.stringify([outcome, feedback ?? null]),
								respond(entry.nativeId, outcome, feedback),
							);
						}),

		close: () =>
			Effect.suspend(() => {
				closed = true;
				for (const entry of byPublic.values()) entry.delivery?.revoke();
				byNative.clear();
				byPublic.clear();
				settledPlans.clear();
				return handle.close();
			}),
	};
};
