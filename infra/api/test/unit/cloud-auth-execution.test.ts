import { SealedCodexGrant } from "@zuse/contracts";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import {
	executeCloudAuthOperationDirect,
	issueAuthorityGrant,
	prepareExistingCloudAuthAuthority,
} from "../../src/cloud-auth-authority.ts";
import {
	type AuthorityGrantRequest,
	CloudAuthExecution,
	CloudAuthExecutorTask,
	makeCloudAuthExecutor,
} from "../../src/cloud-auth-execution.ts";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";
import { serviceUnavailable } from "../../src/errors.ts";

const input: AuthorityGrantRequest = {
	accountId: "account-a",
	workspaceId: "workspace-a",
	runtimeGeneration: 3,
	providerId: "codex",
	bindProviderId: false,
	recipientPublicJwk: "{}",
	recipientKeyThumbprint: "recipient",
	requestId: "cd4a7d96-fb97-4edc-8435-dbb388ff5cf1",
	reason: "initial",
};
const sealed = new SealedCodexGrant({
	protocolVersion: 1,
	requestId: input.requestId,
	keyThumbprint: "recipient",
	authorityIncarnationId: "incarnation",
	authorityEpoch: 2,
	wrappedKey: "wrapped",
	iv: "iv",
	ciphertext: "sealed",
	tag: "tag",
});
const layer = Layer.mergeAll(
	CloudWorkspaceStoreMemory,
	SandboxProvidersFake,
	Config.layer({
		apiIssuer: "https://api.test",
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make("{}"),
		mintPublicKey: "{}",
		cloudAuthProviderId: "fake",
	}),
);
const transport = (fetch: (request: Request) => Promise<Response>) => {
	const names: string[] = [];
	return {
		names,
		executor: makeCloudAuthExecutor({
			idFromName: (name) => {
				names.push(name);
				return name;
			},
			get: () => ({ fetch }),
		}),
	};
};

describe("account authority execution", () => {
	test("preparation and grants use account affinity and preserve the request fence", async () => {
		const requests: unknown[] = [];
		const { names, executor } = transport(async (request) => {
			const body = await request.json();
			requests.push(body);
			return Response.json(requests.length === 1 ? "ready" : sealed);
		});
		expect(await Effect.runPromise(executor.prepare(input.accountId))).toBe(
			"ready",
		);
		expect(await Effect.runPromise(executor.grant(input))).toEqual(sealed);
		await Effect.runPromise(executor.prepare("account-b"));
		expect(names).toEqual(["account-a", "account-a", "account-b"]);
		expect(requests[1]).toEqual({ op: "grant", input });
	});

	test("an explicit location uses the same account venue for preparation and grants", async () => {
		const names: string[] = [];
		const get = vi.fn(() => ({ fetch: async () => Response.json("ready") }));
		const executor = makeCloudAuthExecutor(
			{
				idFromName: (name) => {
					names.push(name);
					return name;
				},
				get,
			},
			"apac-ne",
		);
		await Effect.runPromise(executor.prepare("account-a"));
		await Effect.runPromise(executor.prepare("account-b"));
		expect(names).toEqual(["apac-ne:account-a", "apac-ne:account-b"]);
		expect(get).toHaveBeenCalledWith("apac-ne:account-a", {
			locationHint: "apac-ne",
		});
	});

	test("credential failures propagate without taking the transport fallback", async () => {
		const { executor } = transport(async () =>
			Response.json(
				{ error: "codex-auth-reconnect-required", status: 503 },
				{ status: 503 },
			),
		);
		const result = await Effect.runPromise(
			executor.grant(input).pipe(Effect.result),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "codex-auth-reconnect-required", status: 503 },
		});
	});

	test.each([
		"disconnect",
		"reset",
		"bad-response",
	])("%s permits the direct fallback", async (failure) => {
		const { executor } = transport(async () => {
			if (failure === "disconnect") throw new Error("socket closed");
			return failure === "reset"
				? new Response(null, { status: 502 })
				: Response.json({ invalid: true });
		});
		expect(await Effect.runPromise(executor.grant(input))).toBeNull();
	});

	test("a stalled executor is bounded and its fetch is aborted", async () => {
		vi.useFakeTimers();
		try {
			let signal: AbortSignal | undefined;
			const { executor } = transport((request) => {
				signal = request.signal;
				return new Promise(() => {});
			});
			const pending = Effect.runPromise(executor.grant(input));
			await vi.advanceTimersByTimeAsync(2001);
			expect(await pending).toBeNull();
			expect(signal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("delegation skips provider access but still validates request IDs", async () => {
		const grant = vi.fn(() => Effect.succeed(sealed));
		const executor = { grant, prepare: () => Effect.succeed("ready" as const) };
		expect(
			await Effect.runPromise(
				issueAuthorityGrant(input).pipe(
					Effect.provide(layer),
					Effect.provideService(CloudAuthExecution, executor),
				),
			),
		).toEqual(sealed);
		const invalid = await Effect.runPromise(
			issueAuthorityGrant({ ...input, requestId: "invalid" }).pipe(
				Effect.provide(layer),
				Effect.provideService(CloudAuthExecution, executor),
				Effect.result,
			),
		);
		expect(invalid).toMatchObject({
			_tag: "Failure",
			failure: { code: "invalid_codex_grant_request" },
		});
		expect(grant).toHaveBeenCalledTimes(1);
	});

	test("missing transport result falls back to the existing authority lookup", async () => {
		const prepare = vi.fn(() => Effect.succeed(null));
		const result = await Effect.runPromise(
			prepareExistingCloudAuthAuthority("account-a").pipe(
				Effect.provide(layer),
				Effect.provideService(CloudAuthExecution, {
					prepare,
					grant: () => Effect.succeed(null),
				}),
			),
		);
		expect(result).toBe("absent");
		expect(prepare).toHaveBeenCalledOnce();
	});

	test("direct object execution disables delegation structurally", async () => {
		const prepare = vi.fn(() =>
			Effect.fail(serviceUnavailable("must-not-recurse")),
		);
		const result = await Effect.runPromise(
			executeCloudAuthOperationDirect({
				op: "prepare",
				accountId: "account-a",
			}).pipe(
				Effect.provide(layer),
				Effect.provideService(CloudAuthExecution, {
					prepare,
					grant: () => Effect.succeed(null),
				}),
			),
		);
		expect(result).toBe("absent");
		expect(prepare).not.toHaveBeenCalled();
	});

	test("object rejects malformed input and masks unexpected implementation failures", async () => {
		const execute = vi.fn(async () => {
			throw new Error("private failure details");
		});
		const task = new CloudAuthExecutorTask(execute);
		const request = (body: unknown) =>
			new Request("https://cloud-auth.internal/execute", {
				method: "POST",
				body: JSON.stringify(body),
			});
		expect((await task.fetch(request({ op: "grant", input: {} }))).status).toBe(
			400,
		);
		expect(execute).not.toHaveBeenCalled();
		const failed = await task.fetch(
			request({ op: "prepare", accountId: "account-a" }),
		);
		expect(failed.status).toBe(502);
		expect(await failed.text()).toBe("");
	});
});
