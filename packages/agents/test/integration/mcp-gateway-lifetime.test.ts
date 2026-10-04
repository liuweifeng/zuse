import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);

test("provider session cleanup permits natural process exit without explicitly closing the shared gateway", async () => {
	const fixture = fileURLToPath(
		new URL("../fixtures/mcp-gateway-exit.mts", import.meta.url),
	);
	const { stdout } = await execute(
		process.execPath,
		["--import", "tsx", fixture],
		{
			timeout: 8_000,
			killSignal: "SIGKILL",
			maxBuffer: 64 * 1024,
		},
	);
	expect(stdout).toContain("gateway-session-cleanup-complete");
}, 10_000);
