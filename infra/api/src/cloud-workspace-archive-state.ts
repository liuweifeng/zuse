import { Option, Schema } from "effect";
import type { CloudWorkspaceRecord } from "./cloud-workspace-store.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const WorkspaceArchiveManifest = Schema.Struct({
	version: Schema.Literal(1),
	operationId: Schema.String,
	workspaceId: Schema.String,
	chatId: Schema.String,
	sessionId: Schema.String,
	chunks: Schema.Array(Digest).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(8192),
	),
	archiveSha256: Digest,
});
export type WorkspaceArchiveManifest = typeof WorkspaceArchiveManifest.Type;
const Archive = Schema.Struct({
	version: Schema.Literal(1),
	id: Schema.String,
	sourceSandboxId: Schema.String,
	archivedAtMs: Schema.Number,
	expiresAtMs: Schema.Number,
	phase: Schema.Literals([
		"uploading",
		"verifying",
		"retiring",
		"retired",
		"restoring",
		"restored",
	]),
	verifiedChunks: Schema.Number,
	manifest: Schema.optionalKey(WorkspaceArchiveManifest),
});
export type WorkspaceArchive = typeof Archive.Type;
export const workspaceArchive = (
	workspace: Pick<CloudWorkspaceRecord, "requestConfig">,
) =>
	Option.getOrUndefined(
		Schema.decodeUnknownOption(Archive)(
			workspace.requestConfig.recoveryArchive,
		),
	);
