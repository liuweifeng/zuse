import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Provision only a new builder. Existing workspace data is never touched.
const version = process.argv[2];
if (!version || !/^[a-z0-9][a-z0-9-]{0,35}$/.test(version)) {
	console.error(
		"Usage: DAYTONA_API_KEY=... DAYTONA_TARGET=... node infra/cloud-sandboxes/daytona-publish.mjs <version>",
	);
	process.exit(1);
}
const key = process.env.DAYTONA_API_KEY;
if (!key) throw new Error("DAYTONA_API_KEY is required");
const base = "https://app.daytona.io/api";
const directory = new URL("./", import.meta.url);
const name = `zuse-base-${version}`;
const seed = `${name}-seed`;
const { vcpuCount, memoryMib } = JSON.parse(
	await readFile(new URL("template-resources.json", directory), "utf8"),
);
const headers = { Authorization: `Bearer ${key}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
async function request(url, method = "GET", body) {
	const response = await fetch(url, {
		method,
		headers: {
			...headers,
			...(body instanceof FormData || body === undefined
				? {}
				: { "Content-Type": "application/json" }),
		},
		body:
			body instanceof FormData
				? body
				: body === undefined
					? undefined
					: JSON.stringify(body),
		redirect: "error",
		signal: AbortSignal.timeout(90_000),
	});
	if (!response.ok)
		throw new Error(`Daytona ${method} failed (${response.status})`);
	const text = await response.text();
	return text ? JSON.parse(text) : undefined;
}
const api = (path, method, body) => request(`${base}${path}`, method, body);
async function waitFor(path, state) {
	for (let i = 0; i < 360; i++) {
		const resource = await api(path);
		if (resource.state === state) return resource;
		if (["error", "build_failed", "destroyed"].includes(resource.state))
			throw new Error(`Daytona resource entered ${resource.state}`);
		await sleep(5000);
	}
	throw new Error(`Daytona timed out waiting for ${state}`);
}
// Check before building artifacts or allocating anything. Never overwrite a release.
const existing = await fetch(`${base}/snapshots/${encodeURIComponent(name)}`, {
	headers,
	signal: AbortSignal.timeout(30_000),
});
if (existing.status !== 404)
	throw new Error(
		existing.ok
			? "Snapshot version already exists; choose a new version"
			: `Daytona authentication failed (${existing.status})`,
	);
const built = spawnSync(
	"bash",
	[fileURLToPath(new URL("prepare-artifacts.sh", directory))],
	{ stdio: "inherit" },
);
if (built.status !== 0) throw new Error("Runtime artifact build failed");
let sandboxId;
let seedId;
try {
	// The same Node base and provisioning stages as the shared Dockerfile.
	const seedSnapshot = await api("/snapshots", "POST", {
		name: seed,
		imageName: "node:22-bookworm",
		cpu: vcpuCount,
		memory: memoryMib / 1024,
		disk: 10,
		entrypoint: ["sleep", "infinity"],
		regionId: process.env.DAYTONA_REGION_ID,
		sandboxClass: "container",
	});
	seedId = seedSnapshot.id;
	await waitFor(`/snapshots/${seed}`, "active");
	const builder = await api("/sandbox", "POST", {
		name: `${name}-builder`,
		snapshot: seed,
		target: process.env.DAYTONA_TARGET,
		user: "root",
		public: false,
		autoStopInterval: 30,
		autoPauseInterval: 0,
		autoDeleteInterval: -1,
		ttlMinutes: 120,
		labels: { "zuse-purpose": "base-template-build" },
	});
	sandboxId = builder.id;
	console.log(`Daytona builder: ${sandboxId}`);
	await waitFor(`/sandbox/${sandboxId}`, "started");
	const proxy = await api(`/sandbox/${sandboxId}/toolbox-proxy-url`);
	if (new URL(proxy.url).protocol !== "https:")
		throw new Error("Invalid toolbox URL");
	const toolbox = `${proxy.url.replace(/\/+$/, "")}/${sandboxId}`;
	async function execute(command) {
		const result = await request(`${toolbox}/process/execute`, "POST", {
			command,
			timeout: 60,
		});
		if ((result.exitCode ?? result.code) !== 0)
			throw new Error(
				"Daytona provisioning command failed; inspect the builder logs",
			);
		return result.result ?? "";
	}
	const provision = "/tmp/zuse-provision";
	await execute(`mkdir -p ${provision}/artifacts`);
	const files = [
		"provision.sh",
		"install-grok.sh",
		"project-builder.sh",
		"workspace-bootstrap.sh",
		"workspace-runtime.sh",
		"git-askpass.sh",
		"github-auth.sh",
		"repository-script.ts",
		"sshd_config",
		"artifacts/zusehq-server.tgz",
		"artifacts/zusehq-serve.tgz",
		"artifacts/runtime-updater.mjs",
	];
	for (const file of files) {
		const form = new FormData();
		form.append(
			"file",
			new Blob([await readFile(new URL(file, directory))]),
			file.split("/").at(-1),
		);
		await request(
			`${toolbox}/files/upload-v2?path=${encodeURIComponent(`${provision}/${file}`)}`,
			"POST",
			form,
		);
	}
	const command = `set -e; export ZUSE_PROVISION_DIR=${provision}; bash ${provision}/provision.sh packages globals runtime layout; test -x /usr/local/bin/zuse; sudo -n -u zuse test -d /home/zuse; touch /tmp/zuse-provision-complete`;
	const trackedCommand = `bash -c ${quote(command)}; code=$?; printf '%s' "$code" > /tmp/zuse-provision-exit; exit "$code"`;
	await execute(
		`nohup bash -c ${quote(trackedCommand)} > /tmp/zuse-provision.log 2>&1 < /dev/null &`,
	);
	let complete = false;
	for (let attempt = 0; attempt < 180; attempt++) {
		const exitCode = (
			await execute(
				"if test -f /tmp/zuse-provision-exit; then cat /tmp/zuse-provision-exit; fi",
			)
		).trim();
		if (exitCode && exitCode !== "0") {
			console.error(await execute("tail -c 8192 /tmp/zuse-provision.log"));
			throw new Error(`Daytona provisioning exited with status ${exitCode}`);
		}
		if (
			(
				await execute(
					"if test -f /tmp/zuse-provision-complete; then printf ready; fi",
				)
			).trim() === "ready"
		) {
			complete = true;
			break;
		}
		await sleep(10000);
	}
	if (!complete)
		throw new Error("Provisioning timed out; inspect /tmp/zuse-provision.log");
	await execute(
		`find ${provision} -type f -delete; find ${provision} -depth -type d -empty -delete`,
	);
	await api(`/sandbox/${sandboxId}/stop`, "POST");
	await waitFor(`/sandbox/${sandboxId}`, "stopped");
	await api(`/sandbox/${sandboxId}/snapshot`, "POST", { name });
	const snapshot = await waitFor(`/snapshots/${name}`, "active");
	console.log(
		JSON.stringify(
			{
				DAYTONA_TEMPLATE_ID: snapshot.id,
				DAYTONA_TEMPLATE_VERSION: version,
				DAYTONA_VCPU_COUNT: String(vcpuCount),
				DAYTONA_MEMORY_MIB: String(memoryMib),
			},
			null,
			2,
		),
	);
} finally {
	if (sandboxId) await api(`/sandbox/${sandboxId}`, "DELETE");
	if (seedId) await api(`/snapshots/${seedId}`, "DELETE");
}
