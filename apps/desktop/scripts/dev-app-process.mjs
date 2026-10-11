import { spawn } from "node:child_process";

export function spawnDevApp(command, args, options) {
	// The shell and its ordinary helpers share a group. The durable engine
	// creates its own group, even while it remains a direct child of the shell.
	return spawn(command, args, {
		...options,
		detached: process.platform !== "win32",
	});
}

export function signalDevApp(app, signal) {
	if (process.platform !== "win32" && typeof app.pid === "number") {
		try {
			process.kill(-app.pid, signal);
			return;
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}
	app.kill(signal);
}
