import { type ChildProcess, spawn } from "node:child_process";

const stopping = new WeakMap<ChildProcess, Promise<void>>();
const GRACE_MS = 1_500;

/** Register a POSIX-detached child immediately after spawn to retire descendants on exit. */
export const watchOwnedProcess = (child: ChildProcess): void => {
	child.once("exit", () => {
		void stopOwnedProcess(child, { processGroup: true });
	});
};

/** The caller must set detached on POSIX before opting into process-group cleanup. */
export const stopOwnedProcess = (
	child: ChildProcess,
	options: { readonly processGroup?: boolean; readonly graceMs?: number } = {},
): Promise<void> => {
	const existing = stopping.get(child);
	if (existing !== undefined) return existing;
	const group = options.processGroup === true && process.platform !== "win32";
	const pid = child.pid;
	const exited = () =>
		child.exitCode !== null || child.signalCode !== null || pid === undefined;
	const groupExists = (): boolean => {
		if (!group || pid === undefined) return false;
		try {
			process.kill(-pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const signal = (value: NodeJS.Signals): void => {
		try {
			if (group && pid !== undefined) process.kill(-pid, value);
			else if (!exited()) child.kill(value);
		} catch {
			// The process can exit between checking it and signalling it.
		}
	};
	const run = async (): Promise<void> => {
		if (exited() && !groupExists()) return;
		if (process.platform === "win32" && pid !== undefined) {
			// Node's child.kill terminates only the parent on Windows.
			await new Promise<void>((resolve) => {
				const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
				});
				const timer = setTimeout(() => {
					killer.kill();
					resolve();
				}, 500);
				const done = () => {
					clearTimeout(timer);
					resolve();
				};
				killer.once("error", done);
				killer.once("close", done);
			});
		} else {
			signal("SIGTERM");
			const deadline = performance.now() + (options.graceMs ?? GRACE_MS);
			while (performance.now() < deadline) {
				if (exited() && !groupExists()) return;
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
			}
		}
		// A group may still contain descendants after its original parent exited.
		signal("SIGKILL");
		const killDeadline = performance.now() + GRACE_MS;
		while (!exited() && performance.now() < killDeadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		}
		if (!exited())
			console.warn(
				"[process] Owned process did not exit after forced shutdown",
			);
	};
	const result = run();
	stopping.set(child, result);
	return result;
};
