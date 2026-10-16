import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { makeDaytonaSandboxProvider } from "../../src/daytona.ts";

const fixture = (
	responses: Array<{ status?: number; body?: unknown }>,
	byokImage?: string,
) => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		const next = responses.shift();
		if (!next) throw new Error("Unexpected request");
		return new Response(
			next.body === undefined ? undefined : JSON.stringify(next.body),
			{ status: next.status ?? 200 },
		);
	};
	return {
		calls,
		adapter: makeDaytonaSandboxProvider(
			{
				apiKey: Redacted.make("managed-secret"),
				templateId: "zuse-base",
				templateVersion: "v1",
				target: "us",
				byokImage,
			},
			{ fetch },
		),
	};
};
const detail = (state: string) => ({
	id: "sandbox-1",
	name: "zuse-test",
	state,
});
const input = {
	sandboxId: "workspace-1",
	providerLabel: "zuse-test",
	env: { HELLO: "world" },
	timeoutSeconds: 300,
	network: { kind: "open" } as const,
	onTimeout: "pause" as const,
};
const run = Effect.runPromise;

describe("Daytona provider", () => {
	test.each([
		"inactive",
		"error",
		"build_failed",
	])("rejects unusable custom snapshot state %s", async (state) => {
		const { adapter } = fixture([{ body: { id: "custom", state } }]);
		if (!adapter.validateTemplate) throw new Error("Missing template check");
		await expect(run(adapter.validateTemplate())).rejects.toMatchObject({
			code: "rejected",
		});
	});
	test.each([
		undefined,
		"ghcr.io/zuse/base@sha256:other",
	])("rejects an unverified portable image identity %s before reuse", async (imageName) => {
		for (const operation of ["validateTemplate", "create"] as const) {
			const { adapter, calls } = fixture(
				[{ body: { id: "collision", state: "active", imageName } }],
				"ghcr.io/zuse/base@sha256:test",
			);
			if (!adapter.withCredentials) throw new Error("Missing BYOK support");
			const own = adapter.withCredentials({ apiKey: Redacted.make("own-key") });
			if (!own.validateTemplate) throw new Error("Missing template check");
			await expect(
				run(
					operation === "create"
						? own.create(input).pipe(Effect.asVoid)
						: own.validateTemplate(),
				),
			).rejects.toMatchObject({ code: "rejected" });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.init?.method).toBe("GET");
		}
	});
	test("imports a portable base once in the BYOK organization, then reuses it", async () => {
		const { adapter, calls } = fixture(
			[
				{ status: 404 },
				{ body: { id: "own-base", state: "building" } },
				{
					body: {
						id: "own-base",
						state: "active",
						imageName: "ghcr.io/zuse/base@sha256:test",
					},
				},
				{ body: detail("started") },
				{ body: detail("started") },
			],
			"ghcr.io/zuse/base@sha256:test",
		);
		if (!adapter.withCredentials) throw new Error("Missing BYOK support");
		const own = adapter.withCredentials({ apiKey: Redacted.make("own-key") });
		await expect(run(own.create(input))).rejects.toMatchObject({
			code: "transient",
		});
		expect(calls[1]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
			name: "zuse-base-v1",
			imageName: "ghcr.io/zuse/base@sha256:test",
		});
		await run(own.create(input));
		expect(JSON.parse(String(calls[3]?.init?.body)).snapshot).toBe(
			"zuse-base-v1",
		);
		for (const call of calls)
			expect(new Headers(call.init?.headers).get("Authorization")).toBe(
				"Bearer own-key",
			);
	});
	test("custom BYOK snapshots override the portable default", async () => {
		const { adapter, calls } = fixture(
			[{ body: { id: "custom", state: "active" } }],
			"ghcr.io/zuse/base@sha256:test",
		);
		if (!adapter.withCredentials) throw new Error("Missing BYOK support");
		const own = adapter.withCredentials({
			apiKey: Redacted.make("own-key"),
			templateId: "custom",
		});
		if (!own.validateTemplate) throw new Error("Missing template check");
		await run(own.validateTemplate());
		expect(calls[0]?.url).toBe("https://app.daytona.io/api/snapshots/custom");
	});
	test("inaccessible private snapshots fail before a build is queued", async () => {
		const { adapter } = fixture([{ status: 404 }]);
		if (!adapter.validateTemplate) throw new Error("Missing template check");
		await expect(run(adapter.validateTemplate())).rejects.toMatchObject({
			code: "not-found",
		});
	});
	test("keeps terminate-on-timeout builders snapshot-capable", async () => {
		const { adapter, calls } = fixture([
			{ body: detail("started") },
			{ body: detail("started") },
		]);
		await run(adapter.create({ ...input, onTimeout: "terminate" }));
		expect(JSON.parse(String(calls[0]?.init?.body)).autoDeleteInterval).toBe(1);
	});

	test("uses Workers-compatible redirect handling without following credential redirects", async () => {
		const { adapter, calls } = fixture([{ status: 404 }, { status: 302 }]);
		expect(await run(adapter.recoverByLabel("missing"))).toBeNull();
		expect(calls[0]?.init?.redirect).toBe("manual");
		await expect(run(adapter.inspect("redirected"))).rejects.toMatchObject({
			code: "rejected",
		});
		expect(calls).toHaveLength(2);
	});

	test.each([
		"starting",
		"stopping",
		"error",
		"unknown",
		"snapshotting",
	])("never bills transitional state %s as running", async (state) => {
		const { adapter, calls } = fixture([{ body: detail(state) }]);
		await expect(run(adapter.inspect("sandbox-1"))).rejects.toMatchObject({
			code: "transient",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.init?.method).toBe("GET");
	});
	test.each([
		"stopped",
		"paused",
		"archived",
	])("observes %s without waking it", async (state) => {
		const { adapter, calls } = fixture([{ body: detail(state) }]);
		expect(await run(adapter.inspect("sandbox-1"))).toMatchObject({
			state: "paused",
		});
		expect(calls).toHaveLength(1);
	});
	test("only missing resources return null; invalid credentials and outages remain failures", async () => {
		for (const status of [401, 403, 429, 500]) {
			const { adapter } = fixture([{ status }]);
			await expect(run(adapter.recoverByLabel("label"))).rejects.toMatchObject({
				code: status < 429 ? "rejected" : "transient",
			});
		}
		expect(
			await run(fixture([{ status: 404 }]).adapter.inspect("missing")),
		).toBeNull();
	});
	test("creates a private, open sandbox from its pinned image without illegal resource overrides", async () => {
		const { adapter, calls } = fixture([
			{ body: detail("creating") },
			{ body: detail("started") },
		]);
		expect(await run(adapter.create(input))).toMatchObject({
			state: "running",
		});
		const body = JSON.parse(String(calls[0]?.init?.body));
		expect(body).toMatchObject({
			snapshot: "zuse-base",
			target: "us",
			public: false,
			autoStopInterval: 5,
			autoDeleteInterval: -1,
			labels: { "zuse-sandbox-id": "workspace-1" },
		});
		expect(body).not.toHaveProperty("networkBlockAll");
		expect(body).not.toHaveProperty("networkAllowList");
		expect(body).not.toHaveProperty("domainAllowList");
		expect(body).not.toHaveProperty("cpu");
		expect(body).not.toHaveProperty("memory");
	});
	test("BYOK rebinds authentication and snapshot without changing the managed adapter", async () => {
		const { adapter, calls } = fixture([
			{ status: 404 },
			{ body: detail("started") },
			{ body: detail("started") },
			{ status: 404 },
		]);
		const connected = adapter.withCredentials?.({
			apiKey: Redacted.make("user-secret"),
			templateId: "user-image",
		});
		expect(connected).toBeDefined();
		if (!connected) return;
		await run(connected.recoverByLabel("check"));
		await run(connected.create(input));
		await run(adapter.recoverByLabel("check"));
		expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
			"Bearer user-secret",
		);
		expect(JSON.parse(String(calls[1]?.init?.body)).snapshot).toBe(
			"user-image",
		);
		expect(new Headers(calls[3]?.init?.headers).get("Authorization")).toBe(
			"Bearer managed-secret",
		);
	});
	test("rejects unsupported policies and sizes before allocating", async () => {
		const { adapter, calls } = fixture([]);
		await expect(
			run(
				adapter.create({
					...input,
					network: {
						kind: "restricted",
						allowOut: ["example.com"],
						denyOut: [],
					},
				}),
			),
		).rejects.toMatchObject({ code: "rejected" });
		await expect(
			run(adapter.create({ ...input, sizeId: "large" })),
		).rejects.toMatchObject({ code: "rejected" });
		expect(calls).toHaveLength(0);
	});
	test("stop/start preserves sandbox identity and reports lost processes", async () => {
		const { adapter, calls } = fixture([
			{ body: detail("started") },
			{},
			{},
			{ body: detail("stopped") },
			{ body: detail("stopped") },
			{},
			{},
			{},
			{},
			{ body: detail("started") },
		]);
		await run(adapter.pause("sandbox-1"));
		expect(await run(adapter.resume("sandbox-1", 600, "pause"))).toMatchObject({
			providerSandboxId: "sandbox-1",
			processContinuity: "lost",
		});
		expect(calls.every((call) => call.url.includes("/sandbox/sandbox-1"))).toBe(
			true,
		);
	});
	test("snapshot retry adopts the existing completed image", async () => {
		const { adapter, calls } = fixture([
			{ body: { id: "snapshot-1", state: "active" } },
			{ body: { id: "snapshot-1", state: "active" } },
		]);
		expect(await run(adapter.snapshot("sandbox-1", "build-1"))).toBe(
			"snapshot-1",
		);
		expect(calls.every((call) => call.init?.method === "GET")).toBe(true);
	});
	test("snapshot publication stops the sandbox before capturing its disk", async () => {
		const { adapter, calls } = fixture([
			{ status: 404 },
			{ body: detail("started") },
			{},
			{},
			{ body: detail("stopped") },
			{},
			{ body: { id: "snapshot-1", state: "active" } },
		]);
		expect(await run(adapter.snapshot("sandbox-1", "build-1"))).toBe(
			"snapshot-1",
		);
		expect(calls[2]?.url).toContain("/autodelete/-1");
		expect(calls[3]?.url).toContain("/stop");
		expect(calls[5]?.url).toContain("/snapshot");
	});
	test("guest transport failure cannot become missing file evidence", async () => {
		const { adapter } = fixture([
			{ body: { url: "https://proxy.daytona.test/toolbox" } },
			{ body: { exitCode: 1, result: "" } },
		]);
		await expect(
			run(adapter.pathExists("sandbox-1", "/important.db")),
		).rejects.toMatchObject({ code: "transient" });
	});
	test("private endpoint uses a signed URL without publishing the sandbox", async () => {
		const { adapter, calls } = fixture([
			{ body: { url: "https://123-signed.proxy.test" } },
		]);
		expect(await run(adapter.resolveEndpoint("sandbox-1", 123))).toEqual({
			httpBaseUrl: "https://123-signed.proxy.test",
			wsBaseUrl: "wss://123-signed.proxy.test",
		});
		expect(calls[0]?.init?.method).toBe("GET");
	});
});

test("does not stop a sandbox when disabling automatic deletion fails", async () => {
	const { adapter, calls } = fixture([
		{ body: detail("started") },
		{ status: 500 },
	]);
	await expect(run(adapter.pause("sandbox-1"))).rejects.toMatchObject({
		code: "transient",
	});
	expect(calls.map((call) => call.url)).toEqual([
		"https://app.daytona.io/api/sandbox/sandbox-1",
		"https://app.daytona.io/api/sandbox/sandbox-1/autodelete/-1",
	]);
});

test("reports actionable account restrictions without exposing provider response bodies", async () => {
	const missingRegion = fixture([
		{
			status: 400,
			body: { message: "This organization does not have a default region." },
		},
	]);
	await expect(run(missingRegion.adapter.create(input))).rejects.toMatchObject({
		diagnostic: "daytona-default-region-required",
	});
});

test("deletes snapshots by UUID even when the caller supplies a name", async () => {
	const { adapter, calls } = fixture([
		{ body: { id: "snapshot-uuid", state: "active" } },
		{},
	]);
	await run(adapter.deleteSnapshot("build-name"));
	expect(calls[0]?.url).toBe("https://app.daytona.io/api/snapshots/build-name");
	expect(calls[1]?.url).toBe(
		"https://app.daytona.io/api/snapshots/snapshot-uuid",
	);
	expect(calls[1]?.init?.method).toBe("DELETE");
});

test("open networking needs no account override; unsupported policies fail before requests", async () => {
	const { adapter, calls } = fixture([]);
	await run(adapter.setNetwork("sandbox-1", { kind: "open" }));
	expect(adapter.forkMachine).toBeUndefined();
	for (const network of [
		{ kind: "quarantined" } as const,
		{ kind: "restricted", allowOut: ["example.com"], denyOut: [] } as const,
	]) {
		await expect(
			run(adapter.create({ ...input, network })),
		).rejects.toMatchObject({ code: "rejected" });
		await expect(
			run(adapter.fork({ ...input, network, snapshotId: "snapshot-1" })),
		).rejects.toMatchObject({ code: "rejected" });
		await expect(
			run(adapter.setNetwork("sandbox-1", network)),
		).rejects.toMatchObject({ code: "rejected" });
	}
	expect(calls).toHaveLength(0);
});

test("short guest operations return exit status and stdout for the auth fast path", async () => {
	const { adapter, calls } = fixture([
		{ body: { url: "https://proxy.daytona.test/toolbox" } },
		{ body: { exitCode: 7, result: "not-ready" } },
	]);
	if (!adapter.runProcess) throw new Error("runProcess missing");
	expect(
		await run(
			adapter.runProcess("sandbox-1", {
				command: "/bin/bash",
				args: ["-c", "printf not-ready; exit 7"],
				user: "zuse",
			}),
		),
	).toEqual({ exitCode: 7, stdout: "not-ready" });
	expect(calls).toHaveLength(2);
});

test("short guest operations reject oversized UTF-8 output", async () => {
	const { adapter } = fixture([
		{ body: { url: "https://proxy.daytona.test/toolbox" } },
		{ body: { exitCode: 0, result: "✓".repeat(22_000) } },
	]);
	if (!adapter.runProcess) throw new Error("runProcess missing");
	await expect(
		run(adapter.runProcess("sandbox-1", { command: "probe" })),
	).rejects.toMatchObject({ code: "transient" });
});
