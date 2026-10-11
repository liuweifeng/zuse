import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Redacted } from "effect";
import { connectionWorkspaceActor } from "../lan-auth/services/connection-identity.ts";
import { AutomationService } from "./service.ts";

export const AutomationHandlersLayer = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler("schedule.create", (input) =>
		Effect.gen(function* () {
			const service = yield* AutomationService;
			const actor = yield* connectionWorkspaceActor;
			return yield* service.create(input, actor);
		}),
	),
	MemoizeRpcs.toLayerHandler("schedule.list", ({ sessionId }) =>
		Effect.flatMap(AutomationService, (service) => service.list(sessionId)),
	),
	MemoizeRpcs.toLayerHandler("schedule.update", (input) =>
		Effect.gen(function* () {
			const service = yield* AutomationService;
			const actor = yield* connectionWorkspaceActor;
			return yield* service.update(input, actor);
		}),
	),
	MemoizeRpcs.toLayerHandler("schedule.delete", ({ sessionId, taskId }) =>
		Effect.flatMap(AutomationService, (service) =>
			service.remove(sessionId, taskId),
		),
	),
	MemoizeRpcs.toLayerHandler(
		"schedule.trigger",
		({ sessionId, taskId, eventId }) =>
			Effect.flatMap(AutomationService, (service) =>
				service.trigger(sessionId, taskId, eventId),
			),
	),
	MemoizeRpcs.toLayerHandler("secrets.request", (input) =>
		Effect.flatMap(AutomationService, (service) =>
			service.requestSecret(input),
		),
	),
	MemoizeRpcs.toLayerHandler("secrets.list", ({ sessionId }) =>
		Effect.flatMap(AutomationService, (service) =>
			service.listSecrets(sessionId),
		),
	),
	MemoizeRpcs.toLayerHandler(
		"secrets.respond",
		({ sessionId, requestId, value }) =>
			Effect.flatMap(AutomationService, (service) =>
				service.respondSecret(
					sessionId,
					requestId,
					value === undefined ? undefined : Redacted.value(value),
				),
			),
	),
);
