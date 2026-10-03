import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	connectLocalEngine,
	type DesktopEngineEndpoint,
	type EngineChannel,
	readEngineEndpoint,
	writeDesktopEngineConfig,
} from "@zusehq/server/desktop-engine";
import { readEngineBuildId } from "../src/engine-launcher.ts";

// Run after the desktop build. Every process and database belongs to this fixture.
const directory = await mkdtemp(join(tmpdir(), "zuse-engine-recovery-"));
const channels = new Set<EngineChannel>();
const supervisorPath = fileURLToPath(
	new URL("../dist-electron/engine-supervisor.cjs", import.meta.url),
);
let supervisor: ChildProcess | undefined;
let exited: Promise<void> = Promise.resolve();
const within = async <T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Engine smoke timed out")),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
const connect = async (endpoint: DesktopEngineEndpoint) => {
	let next = 0;
	const requests = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	const channel = await connectLocalEngine(endpoint, {
		receive: (frame) => {
			if (frame._tag !== "Rpc") return;
			const response = JSON.parse(frame.payload);
			if (response._tag !== "Exit") return;
			const pending = requests.get(response.requestId);
			requests.delete(response.requestId);
			if (response.exit._tag === "Success")
				pending?.resolve(response.exit.value);
			else
				pending?.reject(
					new Error(`RPC failed: ${JSON.stringify(response.exit)}`),
				);
		},
	});
	channels.add(channel);
	void channel.closed.then(() => {
		channels.delete(channel);
		for (const pending of requests.values())
			pending.reject(new Error("Engine disconnected"));
		requests.clear();
	});
	return {
		channel,
		call: (tag: string, payload: unknown) =>
			within(
				new Promise<unknown>((resolve, reject) => {
					const id = String(next++);
					requests.set(id, { resolve, reject });
					if (
						!channel.send({
							_tag: "Rpc",
							payload: JSON.stringify({
								_tag: "Request",
								id,
								tag,
								payload,
								headers: [],
							}),
						})
					) {
						requests.delete(id);
						reject(new Error("Engine rejected request"));
					}
				}),
				10_000,
			),
	};
};
const waitReady = async (previousPid?: number) =>
	within(
		(async () => {
			while (true) {
				if (supervisor?.exitCode !== null || supervisor?.signalCode !== null)
					throw new Error("Engine supervisor exited before readiness");
				const candidate = await readEngineEndpoint(directory);
				if (candidate !== null && candidate.pid !== previousPid) {
					try {
						const probe = await connectLocalEngine(candidate, {
							receive: () => {},
						});
						probe.close();
						await probe.closed;
						return candidate;
					} catch {
						/* A crash can leave the previous endpoint until its replacement publishes. */
					}
				}
				await delay(50);
			}
		})(),
		30_000,
	);

try {
	const reservation = createServer();
	await new Promise<void>((resolve) =>
		reservation.listen(0, "127.0.0.1", resolve),
	);
	const address = reservation.address();
	assert(address !== null && typeof address !== "string");
	await new Promise<void>((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve())),
	);
	const buildId = await readEngineBuildId(supervisorPath);
	const launchConfig = {
		userData: directory,
		appVersion: "engine-smoke",
		buildId,
		apiPort: address.port,
		bindHost: "127.0.0.1",
		advertisedHost: null,
		apiUrl: "http://127.0.0.1:9",
	};
	const configPath = await writeDesktopEngineConfig(launchConfig);
	supervisor = spawn(process.execPath, [supervisorPath, configPath], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			ZUSE_SQLITE_MEMORY: "0",
			MEMOIZE_SQLITE_MEMORY: "0",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	supervisor.stderr?.on("data", (data) => process.stderr.write(data));
	exited = new Promise<void>((resolve, reject) => {
		supervisor?.once("exit", () => resolve());
		supervisor?.once("error", reject);
	});
	const initial = await waitReady();
	assert.equal(initial.buildId, buildId);
	const first = await connect(initial);
	const project = join(directory, "project");
	await mkdir(project);
	const folder = await first.call("workspace.add", { path: project });
	first.channel.close();
	await first.channel.closed;
	const second = await connect(initial);
	assert.deepEqual(await second.call("workspace.list", {}), [folder]);
	assert.equal((await readEngineEndpoint(directory))?.pid, initial.pid);
	console.log(
		"PASS: renderer detach and reattach preserve the engine and its data",
	);
	process.kill(initial.pid, "SIGKILL");
	await within(second.channel.closed, 5_000);
	const recovered = await waitReady(initial.pid);
	assert.equal(recovered.buildId, buildId);
	assert.notEqual(recovered.token, initial.token);
	await assert.rejects(
		connectLocalEngine(
			{ ...recovered, token: initial.token },
			{ receive: () => {} },
		),
	);
	const third = await connect(recovered);
	assert.deepEqual(await third.call("workspace.list", {}), [folder]);
	console.log(
		"PASS: worker crash restarts the engine with durable data and a fresh capability",
	);
	supervisor.kill("SIGTERM");
	await within(exited, 10_000);
	await within(third.channel.closed, 5_000);
	assert.equal(await readEngineEndpoint(directory), null);
	assert.throws(() => process.kill(recovered.pid, 0), { code: "ESRCH" });
	console.log(
		"PASS: supervisor shutdown awaits the worker and removes the endpoint",
	);
	const database = await readFile(join(directory, "zuse.sqlite"));
	await writeDesktopEngineConfig({ ...launchConfig, buildId: "stale-build" });
	for (const entry of [
		supervisorPath,
		fileURLToPath(new URL("../dist-electron/engine-main.cjs", import.meta.url)),
	]) {
		let failure = "";
		supervisor = spawn(process.execPath, [entry, configPath], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		supervisor.stdout?.on("data", (chunk) => {
			failure += String(chunk);
		});
		supervisor.stderr?.on("data", (chunk) => {
			failure += String(chunk);
		});
		exited = new Promise<void>((resolve, reject) => {
			supervisor?.once("exit", () => resolve());
			supervisor?.once("error", reject);
		});
		await within(exited, 10_000);
		assert.notEqual(supervisor.exitCode, 0);
		assert.match(failure, /engine files changed/);
		assert.equal(await readEngineEndpoint(directory), null);
		assert.deepEqual(await readFile(join(directory, "zuse.sqlite")), database);
	}
	console.log(
		"PASS: changed engine builds are rejected before modifying durable data",
	);
} catch (error) {
	process.stderr.write(
		await readFile(join(directory, "engine", "runtime.log"), "utf8").catch(
			() => "",
		),
	);
	throw error;
} finally {
	for (const channel of channels) channel.close();
	if (
		supervisor !== undefined &&
		supervisor.exitCode === null &&
		supervisor.signalCode === null
	) {
		supervisor.kill("SIGTERM");
		await within(exited, 10_000).catch(async () => {
			supervisor?.kill("SIGKILL");
			await exited;
		});
	}
	await rm(directory, { recursive: true, force: true });
}
