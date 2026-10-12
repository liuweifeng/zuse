import {
	CLOUD_RUNTIME_LAUNCH_GRANT_CAPABILITY,
	SealedCodexGrant,
	SealedProviderGrant,
} from "@zuse/contracts";
import { launchGrantRequestId } from "@zuse/utils/cloud-launch-grant";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, test, vi } from "vitest";
import { issueBootstrapLaunchGrantWith } from "../../src/cloud-workspace-routes.ts";
import { serviceUnavailable } from "../../src/errors.ts";

const sealedFields = {
	protocolVersion: 1 as const,
	keyThumbprint: "thumb-1",
	authorityIncarnationId: "incarnation",
	authorityEpoch: 2,
	wrappedKey: "w",
	iv: "i",
	ciphertext: "c",
	tag: "t",
};

const input = {
	codexServingEnabled: true,
	providerServingEnabled: true,
	accountId: "account-1",
	workspaceId: "workspace-1",
	runtimeGeneration: 3,
	agent: "claude",
	capabilities: [CLOUD_RUNTIME_LAUNCH_GRANT_CAPABILITY],
	codexAuthMode: "broker-v1" as const,
	providerAuthMode: "broker-v1" as const,
	recipientPublicJwk: "{}",
	recipientKeyThumbprint: "thumb-1",
};

const issuers = () => ({
	provider: vi.fn(
		(request: {
			readonly providerId: "claude" | "codex" | "cursor" | "grok";
			readonly requestId: string;
		}) =>
			Effect.succeed(
				new SealedProviderGrant({
					...sealedFields,
					providerId: request.providerId,
					requestId: request.requestId,
				}),
			),
	),
	codex: vi.fn((request: { readonly requestId: string }) =>
		Effect.succeed(
			new SealedCodexGrant({ ...sealedFields, requestId: request.requestId }),
		),
	),
});

describe("bootstrap launch grant", () => {
	test("issues the selected provider's grant with a deterministic request id, and the same id on retry", async () => {
		const fakes = issuers();
		const expected = await launchGrantRequestId({
			workspaceId: "workspace-1",
			runtimeGeneration: 3,
			keyThumbprint: "thumb-1",
			providerId: "claude",
			protocolVersion: 1,
		});
		const first = await Effect.runPromise(
			issueBootstrapLaunchGrantWith(fakes)(input),
		);
		const retry = await Effect.runPromise(
			issueBootstrapLaunchGrantWith(fakes)(input),
		);
		expect(first).toBeInstanceOf(SealedProviderGrant);
		expect(first).toMatchObject({ providerId: "claude", requestId: expected });
		expect(retry).toMatchObject({ requestId: expected });
		expect(fakes.provider).toHaveBeenCalledTimes(2);
		expect(fakes.provider.mock.calls[0]?.[0]).toMatchObject({
			accountId: "account-1",
			workspaceId: "workspace-1",
			runtimeGeneration: 3,
			recipientKeyThumbprint: "thumb-1",
			reason: "initial",
		});
		expect(fakes.codex).not.toHaveBeenCalled();
	});

	test("routes Codex through the Codex issuer only under its broker mode", async () => {
		const fakes = issuers();
		const codex = await Effect.runPromise(
			issueBootstrapLaunchGrantWith(fakes)({ ...input, agent: "codex" }),
		);
		expect(codex).toBeInstanceOf(SealedCodexGrant);
		expect(fakes.codex).toHaveBeenCalledTimes(1);
		expect(
			await Effect.runPromise(
				issueBootstrapLaunchGrantWith(fakes)({
					...input,
					agent: "codex",
					codexAuthMode: "legacy-image",
				}),
			),
		).toBeUndefined();
		expect(fakes.codex).toHaveBeenCalledTimes(1);
	});

	test("issues nothing for old runtimes, legacy modes, non-cloud agents, or missing launch intents", async () => {
		const fakes = issuers();
		for (const variant of [
			{ ...input, capabilities: undefined },
			{ ...input, capabilities: ["workspace-authorization-v1"] },
			{ ...input, providerAuthMode: "legacy-image" as const },
			{ ...input, providerAuthMode: "snapshot-native" as const },
			{ ...input, agent: "gemini" },
			{ ...input, agent: undefined },
		]) {
			expect(
				await Effect.runPromise(issueBootstrapLaunchGrantWith(fakes)(variant)),
			).toBeUndefined();
		}
		expect(fakes.provider).not.toHaveBeenCalled();
		expect(fakes.codex).not.toHaveBeenCalled();
	});

	test.each([
		"claude",
		"codex",
	])("respects the %s serving switch independently", async (agent) => {
		const fakes = issuers();
		const flags =
			agent === "codex"
				? { codexServingEnabled: false, providerServingEnabled: true }
				: { codexServingEnabled: true, providerServingEnabled: false };
		expect(
			await Effect.runPromise(
				issueBootstrapLaunchGrantWith(fakes)({ ...input, ...flags, agent }),
			),
		).toBeUndefined();
		expect(fakes.codex).not.toHaveBeenCalled();
		expect(fakes.provider).not.toHaveBeenCalled();
		expect(
			await Effect.runPromise(
				issueBootstrapLaunchGrantWith(fakes)({
					...input,
					...flags,
					agent: agent === "codex" ? "claude" : "codex",
				}),
			),
		).toBeDefined();
	});

	test("a failing or slow authority never blocks bootstrap", async () => {
		const failing = {
			...issuers(),
			provider: vi.fn(() =>
				Effect.fail(serviceUnavailable("claude-auth-reconnect-required")),
			),
		};
		expect(
			await Effect.runPromise(issueBootstrapLaunchGrantWith(failing)(input)),
		).toBeUndefined();

		const slow = { ...issuers(), provider: vi.fn(() => Effect.never) };
		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* issueBootstrapLaunchGrantWith(
					slow,
					1_500,
				)(input).pipe(Effect.forkScoped({ startImmediately: true }));
				yield* TestClock.adjust("1 second");
				expect(fiber.pollUnsafe()).toBeUndefined();
				yield* TestClock.adjust("1 second");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
		);
		expect(outcome).toBeUndefined();
	});
});
