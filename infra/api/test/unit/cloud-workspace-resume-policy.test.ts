import { SandboxProviderError } from "@zuse/sandbox-providers";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";
import {
	cloudWorkspaceProviderNeedsWake,
	cloudWorkspaceResumeIsAlreadyRequested,
	failedWorkspaceResumeTarget,
} from "../../src/cloud-workspace-routes.ts";

describe("failed cloud workspace resume policy", () => {
	test("does not rewrite a workspace whose resume is already in flight", () => {
		for (const state of [
			"paused",
			"resuming",
			"provisioning",
			"setup",
			"ready",
		] as const)
			expect(
				cloudWorkspaceResumeIsAlreadyRequested({
					desiredState: "ready",
					state,
				}),
			).toBe(true);

		expect(
			cloudWorkspaceResumeIsAlreadyRequested({
				desiredState: "paused",
				state: "paused",
			}),
		).toBe(false);
		expect(
			cloudWorkspaceResumeIsAlreadyRequested({
				desiredState: "ready",
				state: "failed",
			}),
		).toBe(false);
	});

	test("restarts the same sandbox after a connection timeout", () => {
		expect(
			failedWorkspaceResumeTarget({
				providerSandboxId: "sandbox-preserve",
				statusCode: "runtime-connection-timeout",
			}),
		).toEqual({ state: "resuming", providerSandboxId: "sandbox-preserve" });
	});

	test("replaces compute only after the provider confirms the sandbox is missing", () => {
		expect(
			failedWorkspaceResumeTarget({
				providerSandboxId: "sandbox-gone",
				statusCode: "provider-sandbox-missing",
			}),
		).toEqual({ state: "queued", providerSandboxId: undefined });
	});

	test("replaces an incomplete sandbox after bootstrap fails before the repository is ready", () => {
		for (const statusCode of [
			"initializing-failed",
			"updating-runtime-failed",
			"starting-runtime-failed",
			"syncing-repository-failed",
		] as const)
			expect(
				failedWorkspaceResumeTarget({
					providerSandboxId: "sandbox-incomplete",
					statusCode,
				}),
			).toEqual({
				state: "queued",
				providerSandboxId: "sandbox-incomplete",
			});
	});
});

describe("provider verification before resume", () => {
	const workspace = {
		state: "ready",
		runtimeState: "online",
		providerSandboxId: "sandbox-preserve",
	} as const;
	test("detects a stopped sandbox despite stale online metadata", async () => {
		const inspect = vi.fn(() =>
			Effect.succeed({
				providerSandboxId: "sandbox-preserve",
				providerLabel: "workspace",
				state: "paused" as const,
			}),
		);
		expect(
			await Effect.runPromise(
				cloudWorkspaceProviderNeedsWake(workspace, { inspect }),
			),
		).toBe(true);
		expect(inspect).toHaveBeenCalledExactlyOnceWith("sandbox-preserve");
	});
	test("leaves healthy running compute untouched", async () => {
		expect(
			await Effect.runPromise(
				cloudWorkspaceProviderNeedsWake(workspace, {
					inspect: () =>
						Effect.succeed({
							providerSandboxId: "sandbox-preserve",
							providerLabel: "workspace",
							state: "running" as const,
						}),
				}),
			),
		).toBe(false);
	});
	test("does not infer stopped compute from a missing sandbox or failed probe", async () => {
		for (const result of [
			Effect.succeed(null),
			Effect.fail(new SandboxProviderError({ code: "transient" })),
		]) {
			const exit = await Effect.runPromiseExit(
				cloudWorkspaceProviderNeedsWake(workspace, { inspect: () => result }),
			);
			expect(exit._tag).toBe("Failure");
		}
	});
	test("does not inspect a workspace whose wake is already underway", async () => {
		const inspect = vi.fn(() => Effect.succeed(null));
		expect(
			await Effect.runPromise(
				cloudWorkspaceProviderNeedsWake(
					{ ...workspace, state: "resuming", runtimeState: "offline" },
					{ inspect },
				),
			),
		).toBe(false);
		expect(inspect).not.toHaveBeenCalled();
	});
});
