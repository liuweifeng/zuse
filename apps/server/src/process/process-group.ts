import { type ChildProcess, spawn } from "node:child_process";

/** Signal a detached process group, with a direct-child fallback if it already exited. */
export const signalProcessGroup = (
	child: ChildProcess,
	signal: NodeJS.Signals,
): void => {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
};

export const SUPERVISED_COMMAND_LEASE_MS = 15_000;

const SUPERVISOR = `
const { spawn } = require('node:child_process');
const [specJson, initialDeadline, hasInput] = process.argv.slice(1);
const spec = JSON.parse(specJson);
let deadline = Number(initialDeadline);
let input = "";
const stop = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } };
const watchdog = setInterval(() => { if (!Number.isFinite(deadline) || Date.now() >= deadline) stop(); }, 250);
process.stdin.on('data', chunk => {
 input += chunk.toString('utf8');
 let end;
 while ((end = input.indexOf('\\n')) >= 0) {
  deadline = Math.min(Number(input.slice(0, end)), Date.now() + ${SUPERVISED_COMMAND_LEASE_MS});
  input = input.slice(end + 1);
 }
 if (input.length > 64) stop();
});
process.stdin.resume();
process.stdin.once('end', stop);
process.stdin.once('error', stop);
if (!Number.isFinite(deadline) || Date.now() >= deadline) stop();
const child = spawn(spec.file, spec.args, { stdio: [hasInput === '1' ? 3 : 'ignore', 'inherit', 'inherit'] });
child.once('error', error => { console.error(error.message); process.exit(127); });
child.once('exit', (code, signal) => { clearInterval(watchdog); process.exitCode = code ?? 1; process.stdin.pause(); process.stdin.destroy(); });
`;
export interface SupervisedProcessOptions {
	readonly stdin?: boolean;
	/** Native harness commands own their descendants; legacy device commands retain their lifecycle. */
	readonly killDescendantsOnExit?: boolean;
	readonly env?: NodeJS.ProcessEnv;
}
/** fd 0 is a private lease pipe; fd 3 is command input, never interpreted as a lease. */
export const spawnSupervisedProcess = (
	file: string,
	args: ReadonlyArray<string>,
	cwd: string,
	deadline = Date.now() + SUPERVISED_COMMAND_LEASE_MS,
	options: SupervisedProcessOptions = {},
): ChildProcess => {
	const child = spawn(
		process.execPath,
		[
			"-e",
			SUPERVISOR,
			JSON.stringify({ file, args }),
			String(deadline),
			options.stdin ? "1" : "0",
		],
		{
			cwd,
			detached: true,
			stdio: options.stdin
				? ["pipe", "pipe", "pipe", "pipe"]
				: ["pipe", "pipe", "pipe"],
			env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
		},
	);

	if (options.killDescendantsOnExit)
		child.once("exit", () => signalProcessGroup(child, "SIGKILL"));
	return child;
};
export const spawnSupervisedCommand = (
	command: string,
	cwd: string,
	deadline = Date.now() + SUPERVISED_COMMAND_LEASE_MS,
	options: SupervisedProcessOptions & { readonly shell?: string } = {},
): ChildProcess =>
	spawnSupervisedProcess(
		options.shell || process.env.SHELL || "/bin/sh",
		["-lc", command],
		cwd,
		deadline,
		options,
	);
