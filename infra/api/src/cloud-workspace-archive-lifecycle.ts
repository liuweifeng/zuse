import {
	resolveSandboxResources,
	type SandboxProviderAdapter,
	WORKSPACE_RUNTIME_PROCESS_SELECTOR,
} from "@zuse/sandbox-providers";
import { Effect } from "effect";
import ARCHIVE_SOURCE from "../../cloud-sandboxes/workspace-archive.sh";
import RUNTIME_SOURCE from "../../cloud-sandboxes/workspace-runtime.sh";
import { importedSnapshot, snapshotBuildCompatible } from "./cloud-snapshot.ts";
import {
	getCloudTranscriptObject,
	openCloudTranscriptKey,
} from "./cloud-transcript.ts";
import { observeCloudRuntimeUsage } from "./cloud-usage.ts";
import {
	readWorkspaceArchiveManifest,
	type WorkspaceArchive,
	workspaceArchive,
	workspaceArchiveCapability,
	workspaceArchiveObjectKey,
} from "./cloud-workspace-archive.ts";
import {
	cloudWorkspaceLayout,
	cloudWorkspaceRepositoryPath,
} from "./cloud-workspace-paths.ts";
import type { SaveClaimedWorkspace } from "./cloud-workspace-reconciler.ts";
import { archivedWorkspaceExpiry } from "./cloud-workspace-retention.ts";
import { nextCloudWorkspaceRuntimeFence } from "./cloud-workspace-runtime-fence.ts";
import {
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { sha256Hex } from "./crypto.ts";

const SCRIPT = "/var/lib/zuse/project-build/workspace-archive.sh";
const RETRY_MS = 5_000;
const OPERATION_TTL_MS = 60 * 60_000;

export const launchWorkspaceArchive = Effect.fn("launchWorkspaceArchive")(
	function* (
		workspace: CloudWorkspaceRecord,
		provider: SandboxProviderAdapter,
		archive: WorkspaceArchive,
		sandboxId: string,
	) {
		const store = yield* CloudWorkspaceStore;
		const api = yield* ApiConfiguration;
		const project = yield* store.getProject(workspace.projectId);
		if (project === null || workspace.wrappedTranscriptKey === undefined)
			return false;
		const layout = cloudWorkspaceLayout(workspace);
		const key = yield* openCloudTranscriptKey(
			workspace.accountId,
			workspace.workspaceId,
			workspace.wrappedTranscriptKey,
		);
		yield* provider.writeTextFile(
			sandboxId,
			SCRIPT,
			ARCHIVE_SOURCE,
			layout.user,
		);
		yield* provider.replaceProcess(
			sandboxId,
			WORKSPACE_RUNTIME_PROCESS_SELECTOR,
			{
				command: "/bin/bash",
				args: [
					"-lc",
					`set -euo pipefail\n${RUNTIME_SOURCE}\ninitialize_workspace_runtime_attempt\nacquire_workspace_runtime_lock\nexec /bin/bash ${SCRIPT}`,
				],
				user: layout.user,
				cwd: layout.home,
				activation: {
					operationId: archive.id,
					generation: Number(workspace.requestConfig.runtimeGeneration),
				},
				env: {
					ZUSE_CLOUD_WORKSPACE_ID: workspace.workspaceId,
					ZUSE_RUNTIME_GENERATION: String(
						workspace.requestConfig.runtimeGeneration,
					),
					ZUSE_RUNTIME_EXPECT_EXISTING_DATA:
						archive.phase === "restoring" ? "0" : "1",
					ZUSE_ARCHIVE_CONFIG: JSON.stringify({
						mode: archive.phase === "restoring" ? "restore" : "backup",
						expiresAtMs: archive.expiresAtMs,
						operationId: archive.id,
						workspaceId: workspace.workspaceId,
						chatId: workspace.chatId,
						sessionId: workspace.initialSessionId,
						home: layout.home,
						repositoryPath: cloudWorkspaceRepositoryPath(
							workspace,
							project.repositoryIdentity,
						),
						url: `${api.apiIssuer}/v1/cloud/workspaces/${encodeURIComponent(workspace.workspaceId)}/archive/${archive.id}`,
						token: yield* workspaceArchiveCapability(workspace, archive),
						key,
					}),
				},
			},
		);
		return true;
	},
);

/** The reconcile lease owns every transition; uploaded objects never mutate the lifecycle row. */
export const reconcileWorkspaceArchive = Effect.fn("reconcileWorkspaceArchive")(
	function* (
		workspace: CloudWorkspaceRecord,
		provider: SandboxProviderAdapter,
		nowMs: number,
		save: SaveClaimedWorkspace,
	) {
		const api = yield* ApiConfiguration;
		let archive = workspaceArchive(workspace);
		const update = (
			changes: Partial<CloudWorkspaceRecord>,
			operation = archive,
		) =>
			save({
				...workspace,
				...changes,
				requestConfig: {
					...workspace.requestConfig,
					...changes.requestConfig,
					recoveryArchive: operation,
				},
				revision: workspace.revision + 1,
				updatedAtMs: nowMs,
			});
		const observeStopped = () =>
			observeCloudRuntimeUsage({
				accountId: workspace.accountId,
				resourceKind: "workspace",
				resourceId: workspace.workspaceId,
				provider: workspace.provider,
				providerSandboxId: workspace.providerSandboxId,
				observedAtMs: nowMs,
				...resolveSandboxResources(
					provider,
					typeof workspace.requestConfig.sizeId === "string"
						? workspace.requestConfig.sizeId
						: undefined,
				),
			});
		if (workspace.desiredState === "deleted") return false;
		if (archive?.phase === "retiring") {
			if (
				archive.manifest === undefined ||
				archive.verifiedChunks !== archive.manifest.chunks.length ||
				archive.sourceSandboxId !== workspace.providerSandboxId
			) {
				yield* update({
					statusCode: "archive-backup-incomplete",
					nextActionAtMs: nowMs + OPERATION_TTL_MS,
				});
				return true;
			}
			// This committed barrier is completed even if an unarchive was requested.
			// No activation may run against the source after this point.
			yield* provider
				.kill(archive.sourceSandboxId)
				.pipe(
					Effect.catchTag("SandboxProviderError", (error) =>
						error.code === "not-found" ? Effect.void : Effect.fail(error),
					),
				);
			yield* observeStopped();
			yield* update(
				{
					providerSandboxId: undefined,
					runtimeState: "offline",
					runningSinceMs: undefined,
					runtimeBootTokenHash: undefined,
					runtimeBootTokenExpiresAtMs: undefined,
					runtimeCredentialHash: undefined,
					statusCode: "archived-without-machine",
					nextActionAtMs:
						workspace.desiredState === "ready"
							? nowMs
							: Number.MAX_SAFE_INTEGER,
				},
				{ ...archive, phase: "retired" },
			);
			return true;
		}
		if (archive?.phase === "retired" && workspace.desiredState === "ready") {
			const store = yield* CloudWorkspaceStore;
			// Account images can be replaced while compute is retired. Restore data
			// onto the current compatible managed image, never a credential-bearing
			// custom snapshot or a deleted historical image.
			const build = yield* store.getActiveAccountBuild(
				workspace.accountId,
				workspace.provider,
			);
			if (
				build === null ||
				importedSnapshot(build) ||
				build.snapshotId === undefined ||
				build.settings?.providerAuthDeliveryVersion !== 1 ||
				build.settings?.codexAuthDeliveryVersion !== 1 ||
				!snapshotBuildCompatible(build, provider.templateVersion)
			) {
				yield* update({
					state: "failed",
					statusCode: "archive-restore-image-required",
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
				});
				return true;
			}
			yield* update(
				{
					state: "queued",
					statusCode: "archive-restore-queued",
					buildId: build.buildId,
					nextActionAtMs: nowMs,
					requestConfig: {
						runtimeActivation: undefined,
						allocationAttempted: false,
						runtimeSessionRecoveryPending: true,
					},
				},
				{
					...archive,
					phase: "restoring",
					expiresAtMs: nowMs + OPERATION_TTL_MS,
				},
			);
			return true;
		}
		if (
			archive?.phase === "restoring" &&
			workspace.providerSandboxId !== undefined
		) {
			if (
				[
					"resume-queued",
					"resume-runtime-recovery-queued",
					"restart-queued",
				].includes(workspace.statusCode)
			) {
				yield* update(
					{
						statusCode: "archive-restoring",
						nextActionAtMs: nowMs,
						requestConfig: {
							...nextCloudWorkspaceRuntimeFence(workspace),
							runtimeActivation: undefined,
						},
					},
					{ ...archive, expiresAtMs: nowMs + OPERATION_TTL_MS },
				);
				return true;
			}
			if (workspace.desiredState !== "ready") {
				yield* provider.pause(workspace.providerSandboxId);
				yield* observeStopped();
				yield* update({
					state: workspace.desiredState === "archived" ? "archived" : "paused",
					runtimeState: "offline",
					runningSinceMs: undefined,
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
				});
				return true;
			}
			const sandbox = yield* provider.inspect(workspace.providerSandboxId);
			if (sandbox === null) {
				// No agent can have started before the restore receipt. Its target
				// can therefore be replaced from the same verified recovery point.
				yield* update({
					providerSandboxId: undefined,
					state: "queued",
					statusCode: "archive-restore-queued",
					runningSinceMs: undefined,
					nextActionAtMs: nowMs,
				});
				return true;
			}
			if (sandbox.state === "paused")
				yield* provider.resume(workspace.providerSandboxId, 3600, "pause");
			const receipt = `/home/zuse/.zuse-recovery/${archive.id}/restored`;
			if (
				yield* provider.pathExists(workspace.providerSandboxId, receipt, "zuse")
			) {
				const value = yield* provider.readTextFile(
					workspace.providerSandboxId,
					receipt,
					"zuse",
				);
				if (value !== archive.id) return true;
				yield* update(
					{
						state: "resuming",
						statusCode: "archive-restored",
						nextActionAtMs: nowMs,
						requestConfig: {
							runtimeActivation: undefined,
							runtimeSessionRecoveryPending: true,
						},
					},
					{ ...archive, phase: "restored" },
				);
			} else if (
				nowMs >= archive.expiresAtMs ||
				(yield* provider.pathExists(
					workspace.providerSandboxId,
					`/home/zuse/.zuse-recovery/${archive.id}/failed-${archive.expiresAtMs}`,
					"zuse",
				))
			) {
				yield* provider.pause(workspace.providerSandboxId);
				yield* observeStopped();
				yield* update({
					state: "failed",
					statusCode: "archive-restore-failed",
					runningSinceMs: undefined,
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
				});
			} else {
				yield* launchWorkspaceArchive(
					workspace,
					provider,
					archive,
					workspace.providerSandboxId,
				);
				yield* update({
					nextActionAtMs: nowMs + RETRY_MS,
					runningSinceMs: workspace.runningSinceMs ?? nowMs,
				});
			}
			return true;
		}
		if (
			(archive?.phase === "uploading" || archive?.phase === "verifying") &&
			workspace.desiredState !== "archived"
		) {
			if (workspace.desiredState === "paused") {
				if (workspace.providerSandboxId !== undefined)
					yield* provider.pause(workspace.providerSandboxId);
				yield* observeStopped();
				yield* update(
					{
						state: "paused",
						statusCode: "paused",
						runtimeState: "offline",
						runningSinceMs: undefined,
						nextActionAtMs: Number.MAX_SAFE_INTEGER,
						requestConfig: {
							runtimeActivation: undefined,
							runtimeSessionRecoveryPending: true,
						},
					},
					{ ...archive, phase: "restored" },
				);
				return true;
			}
			// Unarchive cancels the upload capability and requires a fenced restart;
			// the process on the retained machine may now be the backup helper.
			yield* update(
				{
					state: "resuming",
					statusCode: "resume-queued",
					nextActionAtMs: nowMs,
					requestConfig: {
						runtimeActivation: undefined,
						runtimeSessionRecoveryPending: true,
					},
				},
				{ ...archive, phase: "restored" },
			);
			return true;
		}
		if (archive?.phase === "restoring") return false; // normal allocator, intercepted before runtime launch
		const expires = archivedWorkspaceExpiry(workspace);
		if (
			workspace.state !== "archived" ||
			workspace.desiredState !== "archived" ||
			expires === undefined ||
			nowMs < expires
		)
			return false;
		if (archive?.phase === "retired") return true;
		if (
			api.cloudWorkspaceRecoveryEnabled !== true ||
			(api.cloudWorkspaceRecoveryWorkspaceIds !== undefined &&
				!api.cloudWorkspaceRecoveryWorkspaceIds.includes(
					workspace.workspaceId,
				)) ||
			cloudWorkspaceLayout(workspace).snapshot ||
			workspace.wrappedTranscriptKey === undefined ||
			workspace.providerSandboxId === undefined ||
			provider.supportsFencedProcessReplacement !== true ||
			workspace.requestConfig.providerAuthMode !== "broker-v1" ||
			workspace.requestConfig.codexAuthMode !== "broker-v1"
		) {
			yield* update({
				statusCode: "archive-backup-required",
				nextActionAtMs: nowMs + OPERATION_TTL_MS,
			});
			return true;
		}
		if (
			archive === undefined ||
			archive.phase === "restored" ||
			archive.archivedAtMs !== workspace.archiveRequestedAtMs
		) {
			archive = {
				version: 1,
				id: crypto.randomUUID(),
				sourceSandboxId: workspace.providerSandboxId,
				archivedAtMs: workspace.archiveRequestedAtMs ?? nowMs,
				expiresAtMs: nowMs + OPERATION_TTL_MS,
				phase: "uploading",
				verifiedChunks: 0,
			};
			yield* update(
				{
					runtimeState: "offline",
					runtimeCredentialHash: undefined,
					runtimeBootTokenHash: undefined,
					statusCode: "archive-backing-up",
					nextActionAtMs: nowMs,
					requestConfig: {
						...nextCloudWorkspaceRuntimeFence(workspace),
						runtimeActivation: undefined,
						runtimeSessionRecoveryPending: true,
					},
				},
				archive,
			);
			return true;
		}
		// Boat cannot inspect guest paths while stopped. Wake and persist that
		// transition before probing helper receipts or launching the backup.
		if (
			archive.phase === "uploading" &&
			workspace.runningSinceMs === undefined &&
			nowMs < archive.expiresAtMs
		) {
			yield* provider.resume(workspace.providerSandboxId, 3600, "pause");
			yield* update({
				statusCode: "archive-backing-up",
				runningSinceMs: nowMs,
				nextActionAtMs: nowMs,
			});
			return true;
		}
		if (
			nowMs >= archive.expiresAtMs ||
			(archive.phase === "uploading" &&
				(yield* provider.pathExists(
					workspace.providerSandboxId,
					`/home/zuse/.zuse-recovery/${archive.id}/failed-${archive.expiresAtMs}`,
					"zuse",
				)))
		) {
			yield* provider.pause(workspace.providerSandboxId);
			yield* observeStopped();
			yield* update({
				statusCode: "archive-backup-failed",
				runningSinceMs: undefined,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
			});
			return true;
		}
		if (archive.phase === "uploading") {
			const manifest = yield* readWorkspaceArchiveManifest(workspace, archive);
			if (manifest !== undefined) {
				yield* update(
					{ statusCode: "archive-verifying", nextActionAtMs: nowMs },
					{ ...archive, phase: "verifying", manifest },
				);
			} else {
				yield* launchWorkspaceArchive(
					workspace,
					provider,
					archive,
					workspace.providerSandboxId,
				);
				yield* update({
					nextActionAtMs: nowMs + RETRY_MS,
					runningSinceMs: workspace.runningSinceMs ?? nowMs,
				});
			}
			return true;
		}
		if (archive.phase === "verifying" && archive.manifest !== undefined) {
			const end = Math.min(
				archive.verifiedChunks + 8,
				archive.manifest.chunks.length,
			);
			for (const digest of archive.manifest.chunks.slice(
				archive.verifiedChunks,
				end,
			)) {
				const object = yield* getCloudTranscriptObject(
					workspaceArchiveObjectKey(workspace.workspaceId, archive.id, digest),
				);
				if (object === null || (yield* sha256Hex(object)) !== digest) {
					yield* provider.pause(workspace.providerSandboxId);
					yield* observeStopped();
					yield* update({
						statusCode: "archive-backup-incomplete",
						runningSinceMs: undefined,
						nextActionAtMs: nowMs + OPERATION_TTL_MS,
					});
					return true;
				}
			}
			yield* update(
				{ statusCode: "archive-verifying", nextActionAtMs: nowMs },
				{
					...archive,
					verifiedChunks: end,
					phase:
						end === archive.manifest.chunks.length ? "retiring" : "verifying",
				},
			);
			return true;
		}
		return true;
	},
);
