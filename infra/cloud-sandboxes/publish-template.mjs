import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["staging", "production", "byok"].includes(target)) {
	console.error("Template target must be staging, production or byok.");
	process.exit(1);
}

const release = process.argv[3];
if (target === "byok" && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(release ?? "")) {
	throw new Error(
		"BYOK builds require a unique release suffix; never rebuild a published base in place.",
	);
}

const { vcpuCount, memoryMib } = JSON.parse(
	readFileSync(new URL("./template-resources.json", import.meta.url), "utf8"),
);
const templateName =
	target === "byok"
		? `zuse-public-${release}`
		: target === "production"
			? "zuse-cloud-sandbox-production"
			: "zuse-cloud-sandbox";
const result = spawnSync(
	"npx",
	[
		"--yes",
		"@e2b/cli@latest",
		"template",
		"create",
		templateName,
		"--path",
		"infra/cloud-sandboxes",
		"--cmd",
		"sleep infinity",
		"--ready-cmd",
		"true",
		"--cpu-count",
		String(vcpuCount),
		"--memory-mb",
		String(memoryMib),
	],
	{ stdio: "inherit" },
);

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
