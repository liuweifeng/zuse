import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";
import { MasterService } from "./service.ts";
import { masterFailure } from "./store.ts";
import { MasterToolRouter } from "./tool-router.ts";

export const MasterHandlersLayer = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler(
		"masters.agent",
		({ sessionId, commandJson, readOnly, commandId }) =>
			Effect.flatMap(MasterToolRouter, (router) =>
				Effect.tryPromise({
					try: async () => ({
						json: JSON.stringify(
							await router.call(sessionId, commandJson, readOnly, commandId),
						),
					}),
					catch: masterFailure,
				}),
			),
	),
	MemoizeRpcs.toLayerHandler("masters.list", () =>
		Effect.flatMap(MasterService, (service) => service.list()),
	),
	MemoizeRpcs.toLayerHandler("masters.get", ({ masterId }) =>
		Effect.flatMap(MasterService, (service) => service.snapshot(masterId)),
	),
	MemoizeRpcs.toLayerHandler("masters.create", (input) =>
		Effect.flatMap(MasterService, (service) => service.create(input)),
	),
	MemoizeRpcs.toLayerHandler(
		"masters.execute",
		({ masterId, commandId, action }) =>
			Effect.flatMap(MasterService, (service) =>
				service.execute(masterId, commandId, action),
			),
	),
	MemoizeRpcs.toLayerHandler(
		"masters.artifact",
		({ masterId, artifactId, version }) =>
			Effect.flatMap(MasterService, (service) =>
				service.artifact(masterId, artifactId, version),
			),
	),
	MemoizeRpcs.toLayerHandler("masters.target", (input) =>
		Effect.flatMap(MasterService, (service) => service.target(input)),
	),
	MemoizeRpcs.toLayerHandler("masters.transfer", ({ commandId, transfer }) =>
		Effect.flatMap(MasterService, (service) =>
			service.transfer(commandId, transfer),
		),
	),
	MemoizeRpcs.toLayerHandler("masters.activate", ({ masterId, commandId }) =>
		Effect.flatMap(MasterService, (service) =>
			service.activate(masterId, commandId),
		),
	),
	MemoizeRpcs.toLayerHandler("masters.transcript", ({ masterId, sessionId }) =>
		Effect.flatMap(MasterService, (service) =>
			service.transcript(masterId, sessionId),
		),
	),
	MemoizeRpcs.toLayerHandler(
		"masters.workerQuery",
		({ masterId, environmentId, sessionId, query }) =>
			Effect.flatMap(MasterService, (service) =>
				service.workerQuery(masterId, environmentId, sessionId, query),
			),
	),
	MemoizeRpcs.toLayerHandler("masters.watch", ({ masterId }) =>
		Stream.unwrap(
			Effect.map(MasterService, (service) => service.watch(masterId)),
		),
	),
	MemoizeRpcs.toLayerHandler("masters.directory", () =>
		Stream.unwrap(Effect.map(MasterService, (service) => service.directory())),
	),
);
