import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import {
	AttachmentNotFoundError,
	type AttachmentUploadChunk,
	AttachmentUploadError,
	MemoizeRpcs,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { AttachmentUploadChunks } from "./upload-chunks.ts";

const UploadChunk = MemoizeRpcs.toLayerHandler(
	"attachments.uploadChunk",
	Effect.gen(function* () {
		const uploads = yield* Effect.acquireRelease(
			Effect.promise(() => AttachmentUploadChunks.create()),
			(uploads) => Effect.promise(() => uploads.close()),
		);
		const service = yield* AttachmentService;
		return (input: AttachmentUploadChunk) =>
			Effect.gen(function* () {
				const bytes = yield* Effect.tryPromise({
					try: () => uploads.accept(input),
					catch: (cause) =>
						new AttachmentUploadError({
							sessionId: input.sessionId,
							reason:
								cause instanceof Error
									? cause.message
									: "Could not upload this file.",
						}),
				}).pipe(Effect.uninterruptible);
				if (bytes === null) return null;
				return yield* service.upload(
					input.sessionId,
					bytes,
					input.mimeType,
					input.originalName,
					input.rootPath,
				);
			});
	}),
);

const Upload = MemoizeRpcs.toLayerHandler(
	"attachments.upload",
	({ sessionId, bytes, mimeType, originalName, rootPath }) =>
		Effect.flatMap(AttachmentService, (svc) =>
			svc.upload(sessionId, bytes, mimeType, originalName, rootPath),
		),
);

const SaveText = MemoizeRpcs.toLayerHandler(
	"context.saveText",
	({ sessionId, text, ext, rootPath }) =>
		Effect.flatMap(AttachmentService, (svc) =>
			svc.saveText(sessionId, text, ext, rootPath),
		),
);

const Read = MemoizeRpcs.toLayerHandler(
	"attachments.read",
	({ sessionId, id }) =>
		Effect.gen(function* () {
			const svc = yield* AttachmentService;
			const result = yield* svc.readForSession(sessionId, id);
			if (result === null) {
				return yield* new AttachmentNotFoundError({ sessionId, id });
			}
			return result;
		}),
);

export const AttachmentHandlersLayer = Layer.mergeAll(
	Upload,
	UploadChunk,
	Read,
	SaveText,
);
