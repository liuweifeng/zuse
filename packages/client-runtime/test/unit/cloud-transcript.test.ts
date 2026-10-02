import {
	Chat,
	ChatId,
	CloudTranscriptCheckpointPayload,
	EnvironmentId,
	Folder,
	FolderId,
	QueueState,
	Session,
	SessionId,
	SessionTimelineProjection,
} from "@zuse/contracts";
import {
	bytesToBase64Url,
	cloudTranscriptAdditionalData,
	encryptCloudTranscript,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { openCloudTranscriptCheckpoint } from "../../src/cloud-transcript.ts";

const ref = {
	environmentId: EnvironmentId.make("workspace"),
	sessionId: SessionId.make("session"),
};
const folder = Folder.make({
	id: FolderId.make("remote-checkout"),
	path: "/workspace/repo",
	name: "repo",
	addedAt: new Date(0),
});
const chat = Chat.make({
	id: ChatId.make("chat"),
	projectId: folder.id,
	title: "Shared chat",
	worktreeId: null,
	activeSessionId: ref.sessionId,
	originSessionId: null,
	archivedAt: null,
	lastMessageAt: null,
	lastReadAt: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
});
const session = Session.make({
	id: ref.sessionId,
	projectId: folder.id,
	chatId: chat.id,
	title: "Session",
	providerId: "codex",
	model: "test",
	status: "idle",
	archivedAt: null,
	providerThread: null,
	runtimeMode: "approval-required",
	worktreeId: null,
	forkedFromSessionId: null,
	forkedFromMessageId: null,
	permissionMode: "default",
	toolSearch: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
});
const context = { session, chat, folder };

const checkpoint = async (
	value?: CloudTranscriptCheckpointPayload["context"],
) => {
	const cursor = { epoch: "epoch", version: 4 };
	const transcriptKey = bytesToBase64Url(new Uint8Array(32).fill(7));
	const payload = CloudTranscriptCheckpointPayload.make({
		schemaVersion: 1,
		workspaceId: ref.environmentId,
		sessionId: ref.sessionId,
		cursor,
		context: value,
		projection: SessionTimelineProjection.make({
			messages: [],
			status: "idle",
			activeTurn: null,
			turnCount: 0,
			queue: QueueState.make({ items: [], paused: false }),
			permissionMode: "default",
			runtimeMode: "approval-required",
		}),
	});
	const plaintext = new TextEncoder().encode(
		JSON.stringify(
			Schema.encodeSync(CloudTranscriptCheckpointPayload)(payload),
		),
	);
	const ciphertext = await encryptCloudTranscript({
		encodedKey: transcriptKey,
		additionalData: cloudTranscriptAdditionalData({
			workspaceId: ref.environmentId,
			sessionId: ref.sessionId,
			...cursor,
			schemaVersion: 1,
		}),
		plaintext,
	});
	return {
		transcriptKey,
		ciphertext,
		metadata: {
			workspaceId: ref.environmentId,
			sessionId: ref.sessionId,
			runtimeGeneration: 1,
			cursor,
			objectKey: "checkpoint",
			ciphertextSha256: await sha256Base64Url(ciphertext),
			ciphertextBytes: ciphertext.length,
			createdAt: 0,
		},
	};
};

it("opens existing checkpoints without context and preserves the original encryption binding", async () => {
	const payload = await openCloudTranscriptCheckpoint(ref, await checkpoint());
	expect(payload.context).toBeUndefined();
	expect(payload.cursor).toEqual({ epoch: "epoch", version: 4 });
});

it("recovers authenticated session and checkout identities without a runtime connection", async () => {
	const payload = await openCloudTranscriptCheckpoint(
		ref,
		await checkpoint(context),
	);
	expect(payload.context).toEqual(context);
});

it.each([
	{
		...context,
		session: Session.make({ ...session, id: SessionId.make("other") }),
	},
	{
		...context,
		session: Session.make({ ...session, chatId: ChatId.make("other") }),
	},
	{
		...context,
		session: Session.make({ ...session, projectId: FolderId.make("other") }),
	},
	{
		...context,
		chat: Chat.make({ ...chat, projectId: FolderId.make("other") }),
	},
])("rejects internally inconsistent encrypted context", async (value) => {
	await expect(
		openCloudTranscriptCheckpoint(ref, await checkpoint(value)),
	).rejects.toThrow("context mismatch");
});
