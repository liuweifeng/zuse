import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { CheckpointService } from "./service.ts";
export const CheckpointHandlersLayer = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler("session.checkpoints.list", ({ sessionId }) =>
		Effect.flatMap(CheckpointService, (service) => service.list(sessionId)),
	),
	MemoizeRpcs.toLayerHandler(
		"session.checkpoints.preview",
		({ sessionId, checkpointId }) =>
			Effect.flatMap(CheckpointService, (service) =>
				service.preview(sessionId, checkpointId),
			),
	),
	MemoizeRpcs.toLayerHandler(
		"session.checkpoints.restore",
		({ sessionId, previewId }) =>
			Effect.flatMap(CheckpointService, (service) =>
				service.restore(sessionId, previewId),
			),
	),
	MemoizeRpcs.toLayerHandler("session.checkpoints.retry", ({ sessionId }) =>
		Effect.flatMap(CheckpointService, (service) => service.retry(sessionId)),
	),
);
