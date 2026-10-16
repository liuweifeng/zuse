import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { SessionId, SessionNotFoundError } from "./session.ts";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export const ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024;

export const AttachmentUploadResult = Schema.Struct({
	id: Schema.String,
	sizeBytes: Schema.Number,
	mimeType: Schema.String,
	ext: Schema.String,
});
export type AttachmentUploadResult = typeof AttachmentUploadResult.Type;

const AttachmentUploadFields = {
	sessionId: SessionId,
	bytes: Schema.Uint8ArrayFromBase64,
	mimeType: Schema.String,
	originalName: Schema.String,
	rootPath: Schema.optional(Schema.String),
};

export class AttachmentUploadError extends Schema.TaggedErrorClass<AttachmentUploadError>()(
	"AttachmentUploadError",
	{ sessionId: SessionId, reason: Schema.String },
) {}

export class AttachmentTooLargeError extends Schema.TaggedErrorClass<AttachmentTooLargeError>()(
	"AttachmentTooLargeError",
	{
		sessionId: SessionId,
		sizeBytes: Schema.Number,
		limit: Schema.Number,
	},
) {}

export class AttachmentBadMimeError extends Schema.TaggedErrorClass<AttachmentBadMimeError>()(
	"AttachmentBadMimeError",
	{
		sessionId: SessionId,
		mimeType: Schema.String,
	},
) {}

export class AttachmentNotFoundError extends Schema.TaggedErrorClass<AttachmentNotFoundError>()(
	"AttachmentNotFoundError",
	{
		sessionId: SessionId,
		id: Schema.String,
	},
) {}

/**
 * Upload a file attachment for a session. Bytes land in the workspace's
 * gitignored `.context/files/` directory; the returned id is what the
 * renderer stores on `ComposerInput.attachments` and renders via
 * `zuse://attachments/<id>`.
 *
 * `rootPath` is an optional fallback workspace root the renderer already
 * knows. The server prefers to resolve the cwd from `sessionId`, but for a
 * brand-new chat whose session row does not exist yet the fallback keeps
 * drop/paste working; when neither resolves, the upload reports
 * SessionNotFoundError so startup can wait for the workspace to be ready.
 */
export const AttachmentUploadRpc = Rpc.make("attachments.upload", {
	payload: Schema.Struct(AttachmentUploadFields),
	success: AttachmentUploadResult,
	error: Schema.Union([
		AttachmentTooLargeError,
		AttachmentBadMimeError,
		SessionNotFoundError,
	]),
});

export const AttachmentUploadChunk = Schema.Struct({
	...AttachmentUploadFields,
	uploadId: Schema.String.check(Schema.isMaxLength(128)),
	offset: Schema.Number,
	totalBytes: Schema.Number,
});
export type AttachmentUploadChunk = typeof AttachmentUploadChunk.Type;

/** Sequential chunks; only the final response publishes an attachment. */
export const AttachmentUploadChunkRpc = Rpc.make("attachments.uploadChunk", {
	payload: AttachmentUploadChunk,
	success: Schema.NullOr(AttachmentUploadResult),
	error: Schema.Union([
		AttachmentUploadError,
		AttachmentTooLargeError,
		AttachmentBadMimeError,
		SessionNotFoundError,
	]),
});

/**
 * Read an attachment over the authenticated RPC channel. The session id is
 * checked alongside the opaque attachment id so a stale reference cannot
 * accidentally resolve media belonging to another session.
 */
export const AttachmentReadRpc = Rpc.make("attachments.read", {
	payload: Schema.Struct({
		sessionId: SessionId,
		id: Schema.String,
	}),
	success: Schema.Struct({
		bytes: Schema.Uint8ArrayFromBase64,
		mimeType: Schema.String,
		originalName: Schema.String,
		sizeBytes: Schema.Number,
	}),
	error: AttachmentNotFoundError,
});
