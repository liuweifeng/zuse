import { NodeServices } from "@effect/platform-node";
import { SimulatorTools } from "@zuse/agents/drivers/simulator-tools";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { AgentSessionId, FolderId, type SettingsFile } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { AnalyticsService } from "../../src/analytics/services/analytics-service.ts";
import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import { ModelCatalogService } from "../../src/model-catalog/services/model-catalog-service.ts";
import { AcpAgentService } from "../../src/provider/acp/service.ts";
import { ProviderServiceLive } from "../../src/provider/layers/provider-service.ts";
import { BrowserBridgeService } from "../../src/provider/services/browser-bridge-service.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";
import { PermissionService } from "../../src/provider/services/permission-service.ts";
import { ProviderService } from "../../src/provider/services/provider-service.ts";
import { RuntimeGitExecution } from "../../src/provider/services/runtime-git-execution.ts";
import { RuntimeProviderCredentials } from "../../src/provider/services/runtime-provider-credentials.ts";
import { SkillDiscoveryService } from "../../src/skill/services/skill-discovery.ts";
import { WorkspaceService } from "../../src/workspace/services/workspace-service.ts";

/** Fail unexpected dependencies instead of accidentally invoking an actual provider. */
function unused<T>(overrides: Partial<T> = {}): T {
	return new Proxy(overrides, {
		get: (target, property) => {
			if (property in target) return Reflect.get(target, property);
			throw new Error(`Unexpected dependency: ${String(property)}`);
		},
	}) as T;
}

it.each([
	"claude",
	"zuse",
] as const)("%s auxiliary turns bypass the cloud Git broker; ordinary turns still require it", async (providerId) => {
	const resolve = vi.fn(async () => {
		throw new Error("Cloud GitHub execution has no persisted actor");
	});
	const findById = vi.fn(() => Effect.succeed(null));
	const dependencies = Layer.mergeAll(
		NodeServices.layer,
		Layer.succeed(AcpAgentService, unused()),
		Layer.succeed(CredentialsService, unused()),
		Layer.succeed(RuntimeProviderCredentials, unused()),
		Layer.succeed(ModelCatalogService, unused()),
		Layer.succeed(PermissionService, unused()),
		Layer.succeed(AttachmentService, unused()),
		Layer.succeed(SimulatorTools, unused()),
		Layer.succeed(BrowserBridgeService, unused()),
		Layer.succeed(SkillDiscoveryService, unused()),
		Layer.succeed(
			ConfigStoreService,
			unused<ConfigStoreService["Service"]>({
				getSettings: () =>
					Effect.succeed(unused<SettingsFile>({ providerBinaryPaths: {} })),
			}),
		),
		Layer.succeed(
			WorkspaceService,
			unused<WorkspaceService["Service"]>({ findById }),
		),
		Layer.succeed(
			AnalyticsService,
			unused<AnalyticsService["Service"]>({ capture: () => Effect.void }),
		),
		Layer.succeed(RuntimeGitExecution, { resolve, install: () => () => {} }),
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const provider = yield* ProviderService;
			const input = {
				providerId,
				folderId: FolderId.make("missing-memory-workspace"),
				mode: "sdk" as const,
			};
			// Stop at the workspace boundary, before any model/auth/driver work.
			const auxiliary = yield* Effect.result(
				provider.start({
					...input,
					sessionId: AgentSessionId.make("memory-dream-test"),
					outputOnly: true,
				}),
			);
			expect(auxiliary).toMatchObject({
				_tag: "Failure",
				failure: { reason: "Folder missing-memory-workspace not found." },
			});
			expect(findById).toHaveBeenCalledOnce();
			expect(resolve).not.toHaveBeenCalled();
			const ordinary = yield* Effect.result(
				provider.start({
					...input,
					sessionId: AgentSessionId.make("ordinary-turn-test"),
				}),
			);
			expect(ordinary).toMatchObject({
				_tag: "Failure",
				failure: { reason: "Cloud GitHub execution has no persisted actor" },
			});
			expect(resolve).toHaveBeenCalledExactlyOnceWith("ordinary-turn-test");
			expect(findById).toHaveBeenCalledOnce();
		}).pipe(
			Effect.provide(ProviderServiceLive.pipe(Layer.provide(dependencies))),
			Effect.scoped,
		),
	);
});
