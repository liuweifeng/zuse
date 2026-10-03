import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runOwnedHelper } from "../../src/owned-helper.ts";

if (process.argv[2] === "owner") {
	const child = spawn(
		process.execPath,
		["--import", "tsx", fileURLToPath(import.meta.url), "helper"],
		{
			stdio: ["pipe", "inherit", "inherit"],
		},
	);
	console.log(JSON.stringify({ guard: child.pid }));
	process.stdin.resume();
	process.stdin.on("end", () => child.stdin?.end());
	child.once("exit", () => process.exit());
} else {
	process.exitCode = await runOwnedHelper(process.execPath, [
		"-e",
		`
		process.on("SIGTERM", () => {});
		console.log(JSON.stringify({ helper: process.pid }));
		setInterval(() => {}, 1000);
	`,
	]);
}
