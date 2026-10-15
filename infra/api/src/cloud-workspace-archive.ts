import {
	type WorkspaceArchive,
	WorkspaceArchiveManifest,
	workspaceArchive,
} from "./cloud-workspace-archive-state.ts";

export {
	type WorkspaceArchive,
	WorkspaceArchiveManifest,
	workspaceArchive,
} from "./cloud-workspace-archive-state.ts";

import { Effect, Schema } from "effect";
import { digestApiString } from "./api-sealing.ts";
import {
	getCloudTranscriptObject,
	putCloudTranscriptObject,
} from "./cloud-transcript.ts";
import {
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { sha256Hex } from "./crypto.ts";
import { badRequest, notFound, unauthorized } from "./errors.ts";

export const workspaceArchiveObjectKey = (
	workspaceId: string,
	operationId: string,
	object: string,
) =>
	`workspaces/${encodeURIComponent(workspaceId)}/archives/${encodeURIComponent(operationId)}/${object}`;

export const workspaceArchiveCapability = (
	workspace: CloudWorkspaceRecord,
	archive: WorkspaceArchive,
) =>
	digestApiString(
		"workspace-archive",
		JSON.stringify([
			workspace.accountId,
			workspace.workspaceId,
			archive.id,
			archive.expiresAtMs,
			archive.phase === "restoring" ? "read" : "write",
		]),
	);

export const readWorkspaceArchiveManifest = Effect.fn(
	"readWorkspaceArchiveManifest",
)(function* (workspace: CloudWorkspaceRecord, archive: WorkspaceArchive) {
	const object = yield* getCloudTranscriptObject(
		workspaceArchiveObjectKey(workspace.workspaceId, archive.id, "manifest"),
	);
	if (object === null) return undefined;
	const manifest = yield* Effect.try({
		try: () =>
			Schema.decodeUnknownSync(WorkspaceArchiveManifest)(JSON.parse(object)),
		catch: () => badRequest("workspace_archive_invalid"),
	});
	if (
		manifest.workspaceId !== workspace.workspaceId ||
		manifest.operationId !== archive.id ||
		manifest.chatId !== workspace.chatId ||
		manifest.sessionId !== workspace.initialSessionId
	)
		return yield* badRequest("workspace_archive_identity_mismatch");
	return manifest;
});

/** Capability is scoped to one archive, direction and expiration, never a runtime or account credential. */
export const routeWorkspaceArchiveObject = Effect.fn(
	"routeWorkspaceArchiveObject",
)(function* (request: Request, nowMs: number) {
	const match =
		/^\/v1\/cloud\/workspaces\/([^/]+)\/archive\/([^/]+)\/(manifest|[a-f0-9]{64})$/u.exec(
			new URL(request.url).pathname,
		);
	if (match === null) return null;
	const store = yield* CloudWorkspaceStore;
	const workspace = yield* store.getWorkspace(
		decodeURIComponent(match[1] ?? ""),
	);
	const archive = workspace === null ? undefined : workspaceArchive(workspace);
	if (
		workspace === null ||
		archive === undefined ||
		archive.id !== match[2] ||
		archive.expiresAtMs <= nowMs ||
		workspace.state === "deleted" ||
		workspace.desiredState === "deleted" ||
		request.headers.get("authorization") !==
			`Bearer ${yield* workspaceArchiveCapability(workspace, archive)}`
	)
		return yield* unauthorized("workspace_archive_capability_invalid");
	const object = match[3] ?? "";
	const key = workspaceArchiveObjectKey(
		workspace.workspaceId,
		archive.id,
		object,
	);
	if (request.method === "GET" && archive.phase === "restoring") {
		const body = yield* getCloudTranscriptObject(key);
		if (body === null)
			return yield* notFound("workspace_archive_object_missing");
		return new Response(body, {
			headers: { "content-type": "text/plain", "cache-control": "no-store" },
		});
	}
	if (
		request.method !== "PUT" ||
		archive.phase !== "uploading" ||
		workspace.desiredState !== "archived"
	)
		return yield* unauthorized("workspace_archive_operation_inactive");
	// Stream the limit rather than trusting Content-Length. Each encrypted chunk is 4 MiB + base64 overhead.
	const body = yield* Effect.tryPromise({
		try: async () => {
			const reader = request.body?.getReader();
			if (reader === undefined) throw new Error("empty archive object");
			const limit = object === "manifest" ? 1024 * 1024 : 6 * 1024 * 1024;
			const decoder = new TextDecoder();
			let bytes = 0;
			let text = "";
			try {
				while (true) {
					const part = await reader.read();
					if (part.done) break;
					bytes += part.value.byteLength;
					if (bytes > limit) throw new Error("archive object too large");
					text += decoder.decode(part.value, { stream: true });
				}
				return text + decoder.decode();
			} finally {
				await reader.cancel();
			}
		},
		catch: () => badRequest("workspace_archive_object_invalid"),
	});
	if (object === "manifest") {
		const manifest = yield* Effect.try({
			try: () =>
				Schema.decodeUnknownSync(WorkspaceArchiveManifest)(JSON.parse(body)),
			catch: () => badRequest("workspace_archive_manifest_invalid"),
		});
		if (
			manifest.workspaceId !== workspace.workspaceId ||
			manifest.operationId !== archive.id ||
			manifest.chatId !== workspace.chatId ||
			manifest.sessionId !== workspace.initialSessionId
		)
			return yield* badRequest("workspace_archive_identity_mismatch");
	} else if ((yield* sha256Hex(body)) !== object)
		return yield* badRequest("workspace_archive_checksum_mismatch");
	yield* putCloudTranscriptObject(key, body);
	return new Response(null, { status: 204 });
});
