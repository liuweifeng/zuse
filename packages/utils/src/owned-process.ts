import { type ChildProcess, execFile, spawn } from "node:child_process";

const stopping = new WeakMap<ChildProcess, Promise<void>>();
const GRACE_MS = 1_500;

/** Register a POSIX-detached child immediately after spawn to retire descendants on exit. */
export const watchOwnedProcess = (child: ChildProcess): void => {
	child.once("exit", () => {
		void stopOwnedProcess(child, { processGroup: true }).catch(() => {
			console.warn("[process] Owned process group cleanup failed");
		});
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
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
			throw error;
		}
	};
	const hasLiveGroupMember = async (): Promise<boolean> => {
		if (!groupExists()) return false;
		// kill(0) also sees orphan zombies. They cannot mutate files, so inspect
		// state before treating a dead group's unreaped members as live work.
		const states = await new Promise<string>((resolve, reject) => {
			execFile(
				"ps",
				["-axo", "pgid=,stat="],
				{ timeout: 1000, maxBuffer: 2 * 1024 * 1024 },
				(error, stdout) => {
					if (error) reject(error);
					else resolve(stdout);
				},
			);
		});
		return states.split("\n").some((line) => {
			const [processGroup, state] = line.trim().split(/\s+/);
			return (
				Number(processGroup) === pid &&
				state !== undefined &&
				!/^[ZX]/.test(state)
			);
		});
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
		while (performance.now() < killDeadline) {
			if (exited() && !(await hasLiveGroupMember())) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("Owned process group did not stop after forced shutdown");
	};
	const result = run();
	stopping.set(child, result);
	void result.catch(() => {
		// A failed observation is not proof of quiescence. Keep successful closes
		// idempotent, but allow an explicit retry to verify/stop the group again.
		if (stopping.get(child) === result) stopping.delete(child);
	});
	return result;
};
