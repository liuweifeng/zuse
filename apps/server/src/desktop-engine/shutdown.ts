import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { connectLocalEngine } from "./client.ts";
import { type DesktopEngineEndpoint, readEngineEndpoint } from "./endpoint.ts";

const exists = (pid: number | undefined): boolean => {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ESRCH"
		);
	}
};

/** A successful result means the old worker and supervisor exited, not just that they accepted. */
export const requestIdleEngineShutdown = async (
	endpoint: DesktopEngineEndpoint,
	options: {
		readonly userData: string;
		readonly signal?: AbortSignal;
		readonly timeoutMs?: number;
	},
): Promise<"stopped" | "busy"> => {
	if (
		!Number.isSafeInteger(endpoint.pid) ||
		endpoint.pid <= 1 ||
		(endpoint.supervisorPid !== undefined &&
			(!Number.isSafeInteger(endpoint.supervisorPid) ||
				endpoint.supervisorPid <= 1))
	)
		throw new Error("Invalid engine process identity.");
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
	const signal =
		options.signal === undefined
			? timeout
			: AbortSignal.any([options.signal, timeout]);
	const id = randomUUID();
	let finish: (
		status: "accepted" | "busy" | "failed" | "disconnected",
	) => void = () => {};
	const result = new Promise<"accepted" | "busy" | "failed" | "disconnected">(
		(resolve) => {
			finish = resolve;
		},
	);
	const channel = await connectLocalEngine(endpoint, {
		signal,
		receive: (frame) => {
			if (frame._tag === "ShutdownResult" && frame.id === id)
				finish(frame.status);
		},
	});
	try {
		void channel.closed.then(() => finish("disconnected"));
		if (!channel.send({ _tag: "ShutdownRequest", id })) channel.close();
		const status = await result;
		if (status === "busy") return "busy";
		if (status === "failed")
			throw new Error("The engine could not verify that shutdown is safe.");
		await channel.closed;
		while (true) {
			signal.throwIfAborted();
			const current = await readEngineEndpoint(options.userData);
			if (current !== null && current.token !== endpoint.token) return "busy";
			if (
				current === null &&
				!exists(endpoint.pid) &&
				!exists(endpoint.supervisorPid)
			)
				return "stopped";
			await delay(50, undefined, { signal });
		}
	} finally {
		channel.close();
	}
};
