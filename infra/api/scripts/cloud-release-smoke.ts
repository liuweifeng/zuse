import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { SandboxProviderAdapter } from "@zuse/sandbox-providers";
import { Effect } from "effect";
import { parse } from "jsonc-parser";
import { sandboxProviderModules } from "../src/sandbox-provider-config.ts";

/** Exercise the real allocation path, not just template metadata. */
export async function checkCloudBase(
	adapter: Pick<
		SandboxProviderAdapter,
		| "providerId"
		| "runProcess"
		| "startProcess"
		| "pathExists"
		| "validateTemplate"
		| "create"
		| "recoverByLabel"
		| "kill"
	>,
) {
	const label = `zuse-release-check-${randomUUID()}`;
	let machineId: string | undefined;
	let allocationAttempted = false;
	const started = Date.now();
	try {
		if (adapter.validateTemplate)
			await Effect.runPromise(adapter.validateTemplate());
		allocationAttempted = true;
		const machine = await Effect.runPromise(
			adapter.create({
				sandboxId: label,
				providerLabel: label,
				timeoutSeconds: 300,
				env: {},
				network: { kind: "open" },
				onTimeout: "terminate",
			}),
		);
		machineId = machine.providerSandboxId;
		const command = "node --version >/dev/null; zuse --help >/dev/null";
		if (adapter.runProcess) {
			const result = await Effect.runPromise(
				adapter.runProcess(machineId, {
					command: "/bin/sh",
					args: ["-ec", `${command}; printf zuse-release-check-ok`],
					user: "zuse",
				}),
			);
			if (
				result.exitCode !== 0 ||
				!result.stdout.includes("zuse-release-check-ok")
			)
				throw new Error("Base runtime execution failed");
		} else {
			// Boat exposes detached execution. A unique completion marker proves
			// that the command finished, rather than only being accepted.
			const marker = `/tmp/${label}`;
			await Effect.runPromise(
				adapter.startProcess(machineId, {
					command: "/bin/sh",
					args: [
						"-ec",
						`trap 'touch ${marker}.failed' EXIT; ${command}; touch ${marker}.ready; trap - EXIT`,
					],
					user: "zuse",
				}),
			);
			const deadline = Date.now() + 60_000;
			while (
				!(await Effect.runPromise(
					adapter.pathExists(machineId, `${marker}.ready`, "zuse"),
				))
			) {
				if (
					Date.now() >= deadline ||
					(await Effect.runPromise(
						adapter.pathExists(machineId, `${marker}.failed`, "zuse"),
					))
				)
					throw new Error("Base runtime execution failed");
				await sleep(500);
			}
		}
	} finally {
		// A lost create response can still have allocated a machine. Recover only
		// this run's random label; never touch customer machines or snapshots.
		if (!machineId && allocationAttempted) {
			machineId = (await Effect.runPromise(adapter.recoverByLabel(label)))
				?.providerSandboxId;
		}
		if (machineId) await Effect.runPromise(adapter.kill(machineId));
	}
	return { provider: adapter.providerId, elapsedMs: Date.now() - started };
}

export async function checkCloudBases(env: Record<string, string | undefined>) {
	// Configure every provider before allocating anything: missing release keys
	// must fail immediately, and configuration uses the API's own modules.
	const registrations = sandboxProviderModules.flatMap((module) => {
		const configured = module.configure({ env });
		return configured && configured.managedPlacementEnabled !== false
			? [configured]
			: [];
	});
	if (registrations.length === 0)
		throw new Error("No managed cloud providers configured");
	for (const { adapter } of registrations) {
		console.log(`Checking ${adapter.providerId} production base…`);
		try {
			console.log(JSON.stringify(await checkCloudBase(adapter)));
		} catch {
			// Provider errors can contain request data. Keep CI output credential-free.
			throw new Error(
				`${adapter.providerId} production base check failed (including cleanup); deployment blocked`,
			);
		}
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const config = parse(
		readFileSync(process.argv[2] ?? "wrangler.production.jsonc", "utf8"),
	);
	await checkCloudBases({ ...process.env, ...config.vars });
}
