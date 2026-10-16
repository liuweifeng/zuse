import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { makeE2bSandboxProvider } from "../../src/e2b.ts";
import type { ProviderSandbox } from "../../src/index.ts";

const apiKey = process.env.E2B_API_KEY;

const LIVE_TEMPLATE = "base";
const LIVE_TIMEOUT_SECONDS = 300;

const pollUntil = async <A>(
	run: () => Promise<A>,
	predicate: (value: A) => boolean,
	attempts = 15,
	delayMs = 1_000,
): Promise<A> => {
	let value = await run();
	for (let attempt = 0; attempt < attempts && !predicate(value); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		value = await run();
	}
	return value;
};

describe.skipIf(apiKey === undefined)("E2B live lifecycle", () => {
	test("drives the full adapter lifecycle against production", {
		timeout: 240_000,
	}, async () => {
		const adapter = makeE2bSandboxProvider({
			// biome-ignore lint/style/noNonNullAssertion: guarded by skipIf
			apiKey: Redacted.make(apiKey!),
			templateId: LIVE_TEMPLATE,
		});
		const runId = Date.now().toString(36);
		const label = `zuse-live-${runId}`;
		const forkLabel = `zuse-live-fork-${runId}`;
		const createdIds: string[] = [];
		let snapshotId: string | null = null;

		try {
			const created = await Effect.runPromise(
				adapter.create({
					sandboxId: `live_${runId}`,
					providerLabel: label,
					timeoutSeconds: LIVE_TIMEOUT_SECONDS,
					env: { ZUSE_LIVE_TEST: runId },
					network: { kind: "quarantined" },
					onTimeout: "pause",
				}),
			);
			createdIds.push(created.providerSandboxId);
			expect(created.providerSandboxId).not.toBe("");
			expect(created.state).toBe("running");

			const inspected = await Effect.runPromise(
				adapter.inspect(created.providerSandboxId),
			);
			expect(inspected?.state).toBe("running");
			expect(inspected?.providerLabel).toBe(label);

			await Effect.runPromise(
				adapter.startProcess(created.providerSandboxId, {
					command: "/bin/bash",
					args: ["-lc", "python3 -m http.server 47837 --bind 0.0.0.0"],
					cwd: "/home/user",
					user: "user",
				}),
			);
			const endpoint = await Effect.runPromise(
				adapter.resolveEndpoint(created.providerSandboxId, 47_837),
			);
			const publicResponse = await pollUntil(
				() =>
					fetch(endpoint.httpBaseUrl).catch(
						() => new Response(null, { status: 503 }),
					),
				(response) => response.ok,
			);
			expect(publicResponse.ok).toBe(true);

			const recovered = await pollUntil(
				() => Effect.runPromise(adapter.recoverByLabel(label)),
				(value): value is ProviderSandbox => value !== null,
			);
			expect(recovered?.providerSandboxId).toBe(created.providerSandboxId);

			await Effect.runPromise(adapter.pause(created.providerSandboxId));
			const paused = await pollUntil(
				() => Effect.runPromise(adapter.inspect(created.providerSandboxId)),
				(value) => value?.state === "paused",
			);
			expect(paused?.state).toBe("paused");
			await Effect.runPromise(adapter.pause(created.providerSandboxId));

			const resumed = await Effect.runPromise(
				adapter.resume(
					created.providerSandboxId,
					LIVE_TIMEOUT_SECONDS,
					"pause",
				),
			);
			expect(resumed.state).toBe("running");

			await Effect.runPromise(
				adapter.extendTimeout(created.providerSandboxId, LIVE_TIMEOUT_SECONDS),
			);

			snapshotId = await Effect.runPromise(
				adapter.snapshot(created.providerSandboxId, `zuse-live-${runId}`),
			);
			expect(snapshotId).not.toBe("");

			const forked = await Effect.runPromise(
				adapter.fork({
					sandboxId: `live_fork_${runId}`,
					providerLabel: forkLabel,
					snapshotId,
					timeoutSeconds: LIVE_TIMEOUT_SECONDS,
					env: { ZUSE_LIVE_TEST: runId },
					network: { kind: "quarantined" },
					onTimeout: "pause",
				}),
			);
			createdIds.push(forked.providerSandboxId);
			expect(forked.state).toBe("running");
			expect(forked.providerSandboxId).not.toBe(created.providerSandboxId);

			await Effect.runPromise(
				adapter.setNetwork(forked.providerSandboxId, { kind: "open" }),
			);
		} finally {
			for (const providerSandboxId of createdIds) {
				await Effect.runPromise(adapter.kill(providerSandboxId));

				await Effect.runPromise(adapter.kill(providerSandboxId));
			}
			if (snapshotId !== null) {
				await Effect.runPromise(adapter.deleteSnapshot(snapshotId));
				await Effect.runPromise(adapter.deleteSnapshot(snapshotId));
			}
		}

		const gone = await pollUntil(
			() => Effect.runPromise(adapter.recoverByLabel(label)),
			(value) => value === null,
		);
		expect(gone).toBeNull();
	});
});
