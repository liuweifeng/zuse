import { Effect, Redacted } from "effect";
import { expect, test } from "vitest";
import { makeDaytonaSandboxProvider } from "../../src/daytona.ts";

const apiKey = process.env.DAYTONA_API_KEY;
const templateId = process.env.DAYTONA_TEMPLATE_ID;

test.skipIf(!apiKey || !templateId).each(["pause", "terminate"] as const)(
	"Daytona BYOK persistence, snapshot restore and private preview (%s timeout)",
	async (onTimeout) => {
		if (!apiKey || !templateId)
			throw new Error("Daytona live configuration missing");
		const base = makeDaytonaSandboxProvider({
			apiKey: Redacted.make("unused-managed-key"),
			templateId,
			templateVersion: "live",
			target: process.env.DAYTONA_TARGET,
		});
		const provider = base.withCredentials?.({
			apiKey: Redacted.make(apiKey),
			templateId,
		});
		if (!provider) throw new Error("BYOK not supported");
		const name = `zuse-live-${crypto.randomUUID()}`;
		const input = {
			sandboxId: name,
			providerLabel: name,
			timeoutSeconds: 600,
			env: {},
			network: { kind: "open" } as const,
			onTimeout,
		};
		let sandboxId: string | undefined;
		let forkId: string | undefined;
		let snapshotId: string | undefined;
		const run = Effect.runPromise;
		try {
			expect(await run(provider.recoverByLabel(`${name}-missing`))).toBeNull();
			const sandbox = await run(provider.create(input));
			sandboxId = sandbox.providerSandboxId;
			expect(await run(provider.recoverByLabel(name))).toMatchObject({
				providerSandboxId: sandboxId,
			});
			await run(provider.setNetwork(sandboxId, { kind: "open" }));
			await expect
				.soft(
					run(
						provider.startProcess(sandboxId, {
							command: "curl",
							args: [
								"--silent",
								"--show-error",
								"--output",
								"/dev/null",
								"--max-time",
								"20",
								"https://api-staging.zuse.sh",
							],
							user: "zuse",
						}),
					),
					"sandbox must reach the Zuse API",
				)
				.resolves.toBeUndefined();
			if (!provider.runProcess)
				throw new Error("short guest operations unavailable");
			expect(
				await run(
					provider.runProcess(sandboxId, {
						command: "/bin/bash",
						args: ["-c", "printf 'daytona-ready'; exit 7"],
						user: "zuse",
					}),
				),
			).toEqual({ exitCode: 7, stdout: "daytona-ready" });
			const file = `/home/zuse/${name}`;
			const database = `/home/zuse/.zuse-data/${name}.sqlite`;
			await run(
				provider.startProcess(sandboxId, {
					command: "/usr/local/bin/zuse",
					args: ["--version"],
					user: "zuse",
				}),
			);
			await run(
				provider.startProcess(sandboxId, {
					command: "sqlite3",
					args: [
						database,
						"CREATE TABLE verification (value TEXT); INSERT INTO verification VALUES ('persistent');",
					],
					user: "zuse",
				}),
			);
			const verifyDatabase = (id: string) =>
				run(
					provider.startProcess(id, {
						command: "python3",
						args: [
							"-c",
							"import sqlite3,sys; db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; assert db.execute('SELECT value FROM verification').fetchone()[0]=='persistent'",
							database,
						],
						user: "zuse",
					}),
				);
			await run(
				provider.writeTextFile(sandboxId, file, "persistent ✓\n", "zuse"),
			);
			expect(await run(provider.readTextFile(sandboxId, file, "zuse"))).toBe(
				"persistent ✓\n",
			);
			await run(provider.pause(sandboxId));
			expect(await run(provider.inspect(sandboxId))).toMatchObject({
				state: "paused",
			});
			expect(await run(provider.resume(sandboxId, 600, "pause"))).toMatchObject(
				{ providerSandboxId: sandboxId, processContinuity: "lost" },
			);
			expect(await run(provider.readTextFile(sandboxId, file, "zuse"))).toBe(
				"persistent ✓\n",
			);
			await verifyDatabase(sandboxId);
			await run(
				provider.startProcess(sandboxId, {
					command: "python3",
					args: ["-m", "http.server", "47837", "--bind", "0.0.0.0"],
					user: "root",
					tag: "daytona-live-http",
					activation: { operationId: name, generation: 1 },
				}),
			);
			const endpoint = await run(provider.resolveEndpoint(sandboxId, 47837));
			// Process activation precedes the HTTP server's socket becoming ready.
			await expect
				.poll(
					async () => {
						const response = await fetch(endpoint.httpBaseUrl, {
							signal: AbortSignal.timeout(10_000),
						});
						await response.body?.cancel();
						return response.status;
					},
					{ timeout: 30_000, interval: 500 },
				)
				.toBe(200);
			snapshotId = await run(
				provider.snapshot(sandboxId, `${name}-image`).pipe(
					Effect.retry({
						times: 3,
						while: (error) => error.code === "transient",
					}),
				),
			);
			const fork = await run(
				provider.fork({ ...input, providerLabel: `${name}-fork`, snapshotId }),
			);
			forkId = fork.providerSandboxId;
			await verifyDatabase(forkId);
			expect(await run(provider.readTextFile(forkId, file, "zuse"))).toBe(
				"persistent ✓\n",
			);
		} finally {
			// Stable names also reclaim allocations whose successful response was lost.
			const cleanup = await Promise.allSettled([
				run(provider.kill(forkId ?? `${name}-fork`)),
				run(provider.kill(sandboxId ?? name)),
			]);
			cleanup.push(
				...(await Promise.allSettled([
					run(provider.deleteSnapshot(snapshotId ?? `${name}-image`)),
				])),
			);
			const failures = cleanup.filter((result) => result.status === "rejected");
			expect.soft(failures, `Daytona cleanup failed for ${name}`).toEqual([]);
		}
	},
	600_000,
);
