import { SandboxProviders } from "@zuse/sandbox-providers";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	routeWorkspaceArchiveObject,
	type WorkspaceArchive,
	workspaceArchive,
	workspaceArchiveCapability,
	workspaceArchiveObjectKey,
} from "../../src/cloud-workspace-archive.ts";
import { reconcileWorkspaceArchive } from "../../src/cloud-workspace-archive-lifecycle.ts";
import {
	ARCHIVED_WORKSPACE_RETENTION_MS,
	archivedWorkspaceExpiry,
	WORKSPACE_DELETION_TOMBSTONE_RETENTION_MS,
} from "../../src/cloud-workspace-retention.ts";
import { workspaceStartupOutcome } from "../../src/cloud-workspace-runtime-scheduling.ts";
import {
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import { sha256Hex } from "../../src/crypto.ts";

const now = 20 * 24 * 60 * 60_000;
const operation: WorkspaceArchive = {
	version: 1,
	id: "archive-test",
	sourceSandboxId: "source-machine",
	archivedAtMs: 0,
	expiresAtMs: now + 60_000,
	phase: "uploading",
	verifiedChunks: 0,
};
const fixture = (archive = operation): CloudWorkspaceRecord => ({
	workspaceId: "workspace-test",
	accountId: "account-test",
	projectId: "project-test",
	buildId: "build-test",
	provider: "fake",
	providerSandboxId: "source-machine",
	runtimeState: "offline",
	chatId: "chat-test",
	initialSessionId: "session-test",
	branch: "task/test",
	baseRef: "origin/main",
	state: "archived",
	desiredState: "archived",
	statusCode: "archived",
	wrappedTranscriptKey: "keep-history-key",
	archiveRequestedAtMs: 0,
	archiveDeleteAtMs: ARCHIVED_WORKSPACE_RETENTION_MS,
	idempotencyKey: "test",
	requestConfig: {
		providerAuthMode: "broker-v1",
		codexAuthMode: "broker-v1",
		recoveryArchive: archive,
	},
	nextActionAtMs: 0,
	revision: 1,
	createdAtMs: 0,
	updatedAtMs: 0,
	lastActivityAtMs: 0,
});
const setup = () => {
	const objects = new Map<string, string>();
	const layer = Layer.mergeAll(
		CloudWorkspaceStoreMemory,
		CloudBillingStoreMemory,
		SandboxProvidersFake,
		Config.layer({
			apiIssuer: "https://api.test",
			workosJwksUrl: "https://unused.test/jwks",
			workosIssuer: "https://unused.test",
			mintPrivateKey: Redacted.make("{}"),
			mintPublicKey: "{}",
			cloudWorkspaceRecoveryEnabled: true,
			cloudDataEncryptionKey: Redacted.make(
				"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			),
			cloudTranscriptObjects: {
				get: async (key) => objects.get(key) ?? null,
				put: async (key, value) => {
					if (objects.has(key)) return "exists";
					objects.set(key, value);
					return "created";
				},
				deletePrefix: async (prefix) => {
					for (const key of objects.keys())
						if (key.startsWith(prefix)) objects.delete(key);
				},
			},
		}),
	);
	return { objects, layer };
};

describe("archive recovery lifecycle", () => {
	test("wakes stopped compute before probing backup receipts", async () => {
		const { layer } = setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const provider = yield* (yield* SandboxProviders).get("fake");
				const resume = vi.fn<typeof provider.resume>(() =>
					Effect.succeed({
						providerSandboxId: "source-machine",
						providerLabel: "archive-test",
						state: "running",
					}),
				);
				let saved: CloudWorkspaceRecord | undefined;
				yield* reconcileWorkspaceArchive(
					fixture(),
					{
						...provider,
						supportsFencedProcessReplacement: true,
						resume,
						pathExists: () =>
							Effect.die(
								"guest paths cannot be inspected before wake is persisted",
							),
					},
					now,
					(record) =>
						Effect.sync(() => {
							saved = record;
						}),
				);
				expect(resume).toHaveBeenCalledWith("source-machine", 3600, "pause");
				expect(saved?.runningSinceMs).toBe(now);
			}).pipe(Effect.provide(layer)),
		);
	});
	test("old thirty-day records become due at ten days without repeatedly bypassing failure backoff", async () => {
		const { layer } = setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const legacy = {
					...fixture(),
					nextActionAtMs: 30 * 24 * 60 * 60_000,
					archiveDeleteAtMs: 30 * 24 * 60 * 60_000,
				};
				yield* store.saveWorkspace(legacy);
				expect(
					(yield* store.listDueWorkspaces(now, 10)).map(
						(row) => row.workspaceId,
					),
				).toEqual([legacy.workspaceId]);
				yield* store.saveWorkspace({
					...legacy,
					statusCode: "archive-backup-required",
					revision: 2,
					updatedAtMs: now,
				});
				expect(yield* store.listDueWorkspaces(now, 10)).toEqual([]);
			}).pipe(Effect.provide(layer)),
		);
	});

	test("archive jobs keep their durable alarm while the workspace is archived", () => {
		expect(workspaceStartupOutcome(fixture(), now)).toEqual({
			kind: "due",
			dueAtMs: now + 1000,
		});
		expect(
			workspaceStartupOutcome(
				{ ...fixture(), nextActionAtMs: Number.MAX_SAFE_INTEGER },
				now,
			).kind,
		).toBe("blocked");
		expect(
			workspaceStartupOutcome(fixture({ ...operation, phase: "retired" }), now)
				.kind,
		).toBe("complete");
	});

	test("shortens old archive deadlines without changing explicit deletion tombstones", () => {
		expect(
			archivedWorkspaceExpiry({
				archiveRequestedAtMs: 0,
				archiveDeleteAtMs: 30 * 24 * 60 * 60_000,
			}),
		).toBe(ARCHIVED_WORKSPACE_RETENTION_MS);
		expect(
			archivedWorkspaceExpiry({
				archiveRequestedAtMs: 0,
				archiveDeleteAtMs: 1,
			}),
		).toBe(1);
		expect(WORKSPACE_DELETION_TOMBSTONE_RETENTION_MS).toBe(
			30 * 24 * 60 * 60_000,
		);
	});

	test.each([
		"missing",
		"corrupt",
		"complete",
	] as const)("%s archive data controls whether retirement is permitted", async (condition) => {
		const { objects, layer } = setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const digest = yield* sha256Hex("encrypted-chunk");
				const manifest = {
					version: 1 as const,
					operationId: operation.id,
					workspaceId: "workspace-test",
					chatId: "chat-test",
					sessionId: "session-test",
					chunks: [digest],
					archiveSha256: digest,
				};
				const archive: WorkspaceArchive = {
					...operation,
					phase: "verifying",
					manifest,
				};
				let current = fixture(archive);
				if (condition !== "missing")
					objects.set(
						workspaceArchiveObjectKey(current.workspaceId, archive.id, digest),
						condition === "corrupt" ? "damaged" : "encrypted-chunk",
					);
				const adapter = yield* (yield* SandboxProviders).get("fake");
				const kill = vi.fn(() => Effect.void);
				const provider = {
					...adapter,
					kill,
					pause: () => Effect.void,
					// A late upload retry can fail after the manifest was accepted.
					// Verification must depend on stored objects, not that receipt.
					pathExists: () => Effect.succeed(true),
					supportsFencedProcessReplacement: true,
				};
				const save = (next: CloudWorkspaceRecord) =>
					Effect.sync(() => {
						current = next;
					});
				yield* reconcileWorkspaceArchive(current, provider, now, save);
				expect(kill).not.toHaveBeenCalled();
				if (condition === "complete") {
					expect(workspaceArchive(current)?.phase).toBe("retiring");
					yield* reconcileWorkspaceArchive(current, provider, now + 1, save);
					expect(kill).toHaveBeenCalledExactlyOnceWith("source-machine");
					expect(current.providerSandboxId).toBeUndefined();
					expect(workspaceArchive(current)?.phase).toBe("retired");
					expect(objects.size).toBe(1);
				} else {
					expect(current.providerSandboxId).toBe("source-machine");
					expect(current.statusCode).toBe("archive-backup-incomplete");
				}
				expect(current.state).toBe("archived");
				expect(current.desiredState).toBe("archived");
				expect(current.wrappedTranscriptKey).toBe("keep-history-key");
				expect(current.chatId).toBe("chat-test");
				expect(current.initialSessionId).toBe("session-test");
			}).pipe(Effect.provide(layer)),
		);
	});

	test.each([
		"uploading",
		"verifying",
	] as const)("unarchive during %s pauses compute and cancels the archive alarm", async (phase) => {
		const { layer } = setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				let current: CloudWorkspaceRecord = {
					...fixture({ ...operation, phase }),
					desiredState: "paused",
					state: "paused",
					runningSinceMs: now - 1000,
				};
				const adapter = yield* (yield* SandboxProviders).get("fake");
				const pause = vi.fn(() => Effect.void);
				yield* reconcileWorkspaceArchive(
					current,
					{ ...adapter, pause },
					now,
					(next) =>
						Effect.sync(() => {
							current = next;
						}),
				);
				expect(pause).toHaveBeenCalledExactlyOnceWith("source-machine");
				expect(current.providerSandboxId).toBe("source-machine");
				expect(current.state).toBe("paused");
				expect(current.runtimeState).toBe("offline");
				expect(current.runningSinceMs).toBeUndefined();
				expect(current.requestConfig.runtimeSessionRecoveryPending).toBe(true);
				expect(workspaceArchive(current)?.phase).toBe("restored");
				expect(current.nextActionAtMs).toBe(Number.MAX_SAFE_INTEGER);
				expect(workspaceStartupOutcome(current, now).kind).toBe("complete");
			}).pipe(Effect.provide(layer)),
		);
	});

	test("immediate resume during backup cancels it and restarts the retained runtime", async () => {
		const { layer } = setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				let current: CloudWorkspaceRecord = {
					...fixture(),
					desiredState: "ready",
					state: "paused",
				};
				const provider = yield* (yield* SandboxProviders).get("fake");
				yield* reconcileWorkspaceArchive(current, provider, now, (next) =>
					Effect.sync(() => {
						current = next;
					}),
				);
				expect(current.providerSandboxId).toBe("source-machine");
				expect(current.state).toBe("resuming");
				expect(workspaceArchive(current)?.phase).toBe("restored");
			}).pipe(Effect.provide(layer)),
		);
	});

	test("reopening retired compute queues restoration without changing conversation identity", async () => {
		const { layer } = setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				yield* store.createBuild({
					buildId: "current-image",
					projectId: "project-test",
					accountId: "account-test",
					provider: "fake",
					snapshotId: "current-snapshot",
					settings: {
						providerAuthDeliveryVersion: 1,
						codexAuthDeliveryVersion: 1,
					},
					templateVersion: "test-template",
					configurationDigest: "digest",
					state: "ready",
					idempotencyKey: "image",
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					revision: 1,
					createdAtMs: now,
					updatedAtMs: now,
				});
				let current: CloudWorkspaceRecord = {
					...fixture({ ...operation, phase: "retired" }),
					providerSandboxId: undefined,
					desiredState: "ready",
				};
				const provider = yield* (yield* SandboxProviders).get("fake");
				yield* reconcileWorkspaceArchive(current, provider, now, (next) =>
					Effect.sync(() => {
						current = next;
					}),
				);
				expect(current.state).toBe("queued");
				expect(current.buildId).toBe("current-image");
				expect(workspaceArchive(current)?.phase).toBe("restoring");
				expect(current.chatId).toBe("chat-test");
				expect(current.requestConfig.runtimeSessionRecoveryPending).toBe(true);
			}).pipe(Effect.provide(layer)),
		);
	});

	test("archive object upload verifies integrity and rejects expired or cross-workspace capabilities", async () => {
		const { objects, layer } = setup();
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const workspace = fixture();
				yield* store.saveWorkspace(workspace);
				const token = yield* workspaceArchiveCapability(workspace, operation);
				const digest = yield* sha256Hex("ciphertext");
				const url = `https://api.test/v1/cloud/workspaces/workspace-test/archive/archive-test/${digest}`;
				const request = (body: string, credential = token) =>
					new Request(url, {
						method: "PUT",
						body,
						headers: { authorization: `Bearer ${credential}` },
					});
				const uploaded = yield* routeWorkspaceArchiveObject(
					request("ciphertext"),
					now,
				);
				expect(uploaded?.status).toBe(204);
				expect(objects.size).toBe(1);
				const mismatch = yield* routeWorkspaceArchiveObject(
					request("wrong"),
					now,
				).pipe(Effect.flip);
				expect(mismatch._tag).toBe("ApiError");
				const expired = yield* routeWorkspaceArchiveObject(
					request("ciphertext"),
					operation.expiresAtMs,
				).pipe(Effect.flip);
				expect(expired._tag).toBe("ApiError");
				const otherToken = yield* workspaceArchiveCapability(
					{ ...workspace, accountId: "another-account" },
					operation,
				);
				const crossed = yield* routeWorkspaceArchiveObject(
					request("ciphertext", otherToken),
					now,
				).pipe(Effect.flip);
				expect(crossed._tag).toBe("ApiError");
				expect(objects.size).toBe(1);
			}).pipe(Effect.provide(layer)),
		);
	});
});
