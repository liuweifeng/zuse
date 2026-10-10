import {
	bytesToBase64Url,
	cloudTranscriptAdditionalData,
	encryptCloudTranscript,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import { Effect, Redacted } from "effect";
import { expect, test, vi } from "vitest";
import { readApiTurnFailure } from "../../src/api-turn-failure.ts";
import {
	type CloudWorkspaceApiMessageRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";

const fixture = vi.hoisted(() => ({ ciphertext: "", key: "" }));
vi.mock("../../src/cloud-transcript.ts", () => ({
	getCloudTranscriptObject: () => Effect.succeed(fixture.ciphertext),
	openCloudTranscriptKey: () => Effect.succeed(fixture.key),
}));
const workspace: CloudWorkspaceRecord = {
	workspaceId: "workspace",
	accountId: "account",
	projectId: "project",
	buildId: "build",
	provider: "boxd",
	runtimeState: "online",
	chatId: "chat",
	initialSessionId: "session",
	branch: "main",
	baseRef: "main",
	state: "ready",
	desiredState: "ready",
	statusCode: "ready",
	wrappedTranscriptKey: "wrapped",
	idempotencyKey: "key",
	requestConfig: { agent: "codex" },
	nextActionAtMs: 0,
	revision: 0,
	createdAtMs: 0,
	updatedAtMs: 0,
	lastActivityAtMs: 0,
};
const submitted: CloudWorkspaceApiMessageRecord = {
	messageId: "message",
	workspaceId: "workspace",
	accountId: "account",
	seq: 1,
	role: "user",
	sealedContent: "sealed",
	turnId: "turn",
	status: "delivered",
	createdAtMs: 1,
};
const projection = (legacy: boolean, turnId = "turn") => ({
	messages: [
		{
			id: "message",
			sessionId: "session",
			role: "user",
			content: { _tag: "user", text: "hello" },
			createdAt: new Date(1).toISOString(),
		},
		{
			id: "error",
			sessionId: "session",
			role: "system",
			content: { _tag: "error", message: "Codex CLI not found" },
			createdAt: new Date(2).toISOString(),
		},
	],
	status: "error",
	queue: { items: [], paused: false },
	permissionMode: "default",
	runtimeMode: "approval-required",
	...(legacy
		? { currentTurn: { turnId, phase: "running" } }
		: {
				activeTurn: {
					id: turnId,
					ordinal: 1,
					status: "running",
					phase: "running",
					attempt: { id: "attempt", ordinal: 1, reason: "initial" },
					providerThreadId: null,
					requestedAt: new Date(1).toISOString(),
					completedAt: null,
				},
				turnCount: 1,
			}),
});
const read = async (
	legacy: boolean,
	turnId = "turn",
	overrides: Record<string, unknown> = {},
) => {
	fixture.key = bytesToBase64Url(new Uint8Array(32).fill(7));
	fixture.ciphertext = await encryptCloudTranscript({
		encodedKey: fixture.key,
		additionalData: cloudTranscriptAdditionalData({
			workspaceId: "workspace",
			sessionId: "session",
			epoch: "epoch",
			version: 4,
			schemaVersion: 1,
		}),
		plaintext: new TextEncoder().encode(
			JSON.stringify({
				schemaVersion: 1,
				workspaceId: "workspace",
				sessionId: "session",
				cursor: { epoch: "epoch", version: 4 },
				projection: projection(legacy, turnId),
				...overrides,
			}),
		),
	});
	const checkpoint = {
		workspaceId: "workspace",
		sessionId: "session",
		runtimeGeneration: 1,
		streamEpoch: "epoch",
		streamVersion: 4,
		objectKey: "checkpoint",
		ciphertextSha256: await sha256Base64Url(fixture.ciphertext),
		ciphertextBytes: fixture.ciphertext.length,
		createdAtMs: 2,
	};
	return Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* CloudWorkspaceStore;
			return yield* readApiTurnFailure(workspace, submitted).pipe(
				Effect.provideService(CloudWorkspaceStore, {
					...store,
					getTranscriptCheckpoint: () => Effect.succeed(checkpoint),
				}),
			);
		}).pipe(
			Effect.provide(CloudWorkspaceStoreMemory),
			Effect.provide(
				configurationLayer({
					apiIssuer: "https://api.test",
					workosJwksUrl: "https://unused.test/jwks",
					workosIssuer: "https://unused.test",
					mintPrivateKey: Redacted.make("unused"),
					mintPublicKey: "unused",
				}),
			),
		),
	);
};
test.each([
	false,
	true,
])("diagnoses authenticated errors for current and legacy checkpoints (%s)", async (legacy) => {
	expect(await read(legacy)).toEqual({
		turnId: "turn",
		agent: "codex",
		code: "agent_not_installed",
		message: "Codex CLI not found",
	});
});
test.each([
	false,
	true,
])("rejects another turn even if its user message matches (%s)", async (legacy) => {
	expect(await read(legacy, "other")).toBeUndefined();
});
test.each([
	{ workspaceId: "other" },
	{ sessionId: "other" },
	{ cursor: { epoch: "other", version: 4 } },
])("rejects authenticated payload identity mismatch %j", async (overrides) => {
	expect(await read(true, "turn", overrides)).toBeUndefined();
});
