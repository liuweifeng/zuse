import { spawn } from "node:child_process";
import { stopOwnedProcess } from "@zuse/utils/owned-process";

/** The launcher owns stdin. EOF retires the helper even after launcher SIGKILL. */
export const runOwnedHelper = async (
	command: string,
	args: readonly string[],
): Promise<number> => {
	const child = spawn(command, [...args], {
		detached: process.platform !== "win32",
		stdio: ["ignore", "inherit", "inherit"],
		windowsHide: true,
	});
	let stopping = false;
	const stop = () => {
		stopping = true;
		void stopOwnedProcess(child, { processGroup: true });
	};
	const exited = new Promise<number>((resolve) => {
		child.once("exit", (code) => resolve(code ?? 1));
		child.once("error", () => resolve(127));
	});
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	process.stdin.once("end", stop);
	process.stdin.once("error", stop);
	process.stdin.resume();
	if (process.stdin.readableEnded || process.stdin.destroyed) stop();
	try {
		const code = await exited;
		return stopping ? 0 : code;
	} finally {
		await stopOwnedProcess(child, { processGroup: true });
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		process.stdin.off("end", stop);
		process.stdin.off("error", stop);
		process.stdin.pause();
	}
};
