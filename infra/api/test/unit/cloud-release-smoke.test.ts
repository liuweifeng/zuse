import { readFileSync } from "node:fs";
import { SandboxProviderError } from "@zuse/sandbox-providers";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import {
	checkCloudBase,
	checkCloudBases,
} from "../../scripts/cloud-release-smoke.ts";

function provider() {
	return {
		providerId: "boxd",
		startProcess: vi.fn(() => Effect.void),
		pathExists: vi.fn(() => Effect.succeed(true)),
		validateTemplate: vi.fn(() => Effect.void),
		create: vi.fn(() =>
			Effect.succeed({
				providerSandboxId: "disposable",
				providerLabel: "test",
				state: "running" as const,
			}),
		),
		runProcess: vi.fn(() =>
			Effect.succeed({ exitCode: 0, stdout: "zuse-release-check-ok" }),
		),
		recoverByLabel: vi.fn(() => Effect.succeed(null)),
		kill: vi.fn(() => Effect.void),
	};
}

describe("production cloud release smoke", () => {
	test("blocks a missing template before allocation", async () => {
		const adapter = provider();
		adapter.validateTemplate.mockReturnValue(Effect.die("not-found"));
		await expect(checkCloudBase(adapter)).rejects.toThrow();
		expect(adapter.create).not.toHaveBeenCalled();
		expect(adapter.kill).not.toHaveBeenCalled();
	});
	test("boots, executes the runtime and cleans up only its own machine", async () => {
		const adapter = provider();
		await expect(checkCloudBase(adapter)).resolves.toMatchObject({
			provider: "boxd",
		});
		expect(adapter.create).toHaveBeenCalledWith(
			expect.objectContaining({
				timeoutSeconds: 300,
				onTimeout: "terminate",
				env: {},
			}),
		);
		expect(adapter.runProcess).toHaveBeenCalledWith(
			"disposable",
			expect.objectContaining({ user: "zuse" }),
		);
		expect(adapter.kill).toHaveBeenCalledExactlyOnceWith("disposable");
	});
	test("runtime failure blocks publication and still cleans up", async () => {
		const adapter = provider();
		adapter.runProcess.mockReturnValue(
			Effect.succeed({ exitCode: 1, stdout: "" }),
		);
		await expect(checkCloudBase(adapter)).rejects.toThrow(
			"runtime execution failed",
		);
		expect(adapter.kill).toHaveBeenCalledExactlyOnceWith("disposable");
	});
	test("waits for detached execution completion on Boat", async () => {
		const adapter = { ...provider(), runProcess: undefined };
		await checkCloudBase(adapter);
		expect(adapter.startProcess).toHaveBeenCalledOnce();
		expect(adapter.pathExists).toHaveBeenCalledWith(
			"disposable",
			expect.stringMatching(/\.ready$/),
			"zuse",
		);
		expect(adapter.kill).toHaveBeenCalledExactlyOnceWith("disposable");
	});

	test("cleanup failure also blocks publication", async () => {
		const adapter = provider();
		adapter.kill.mockReturnValue(Effect.die("cleanup failed"));
		await expect(checkCloudBase(adapter)).rejects.toThrow();
	});
	test("recovers a lost allocation response using only the unique smoke label", async () => {
		const adapter = provider();
		const recovered = {
			...adapter,
			create: vi.fn(() =>
				Effect.fail(new SandboxProviderError({ code: "transient" })),
			),
			recoverByLabel: vi.fn(() =>
				Effect.succeed({
					providerSandboxId: "recovered",
					providerLabel: "test",
					state: "running" as const,
				}),
			),
		};
		await expect(checkCloudBase(recovered)).rejects.toThrow();
		const input = recovered.create.mock.calls[0];
		expect(input).toBeDefined();
		expect(recovered.recoverByLabel).toHaveBeenCalledWith(
			expect.stringMatching(/^zuse-release-check-/),
		);
		expect(adapter.kill).toHaveBeenCalledExactlyOnceWith("recovered");
	});
	test("missing release credentials fail closed", async () => {
		await expect(
			checkCloudBases({
				BOXD_ADAPTER_ENABLED: "true",
				BOXD_TEMPLATE_SNAPSHOT: "base",
				BOXD_TEMPLATE_VERSION: "1",
			}),
		).rejects.toThrow();
	});
	test("both production entrypoints run the gate before publication", () => {
		const deploy = readFileSync(
			new URL("../../scripts/deploy-production.mjs", import.meta.url),
			"utf8",
		);
		expect(deploy.indexOf('"scripts/cloud-release-smoke.ts"')).toBeGreaterThan(
			0,
		);
		expect(deploy.indexOf('"scripts/cloud-release-smoke.ts"')).toBeLessThan(
			deploy.indexOf('["wrangler", "deploy"'),
		);
		const workflow = readFileSync(
			new URL(
				"../../../../.github/workflows/cloud-runtime-staging.yml",
				import.meta.url,
			),
			"utf8",
		);
		expect(workflow).toContain(
			"run: bun scripts/cloud-release-smoke.ts wrangler.production.jsonc",
		);
		expect(workflow.indexOf("Verify production cloud bases")).toBeLessThan(
			workflow.indexOf("Publish immutable runtime"),
		);
	});
});
