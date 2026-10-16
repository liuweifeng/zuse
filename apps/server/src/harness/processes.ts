import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { atomicWritePrivateJson } from "../atomic-private-file.ts";
import {
	SUPERVISED_COMMAND_LEASE_MS,
	signalProcessGroup,
	spawnSupervisedProcess,
} from "../process/process-group.ts";

const recordSchema = z.object({
	id: z.string().uuid(),
	agentId: z.string(),
	label: z.string(),
	cwd: z.string(),
	status: z.enum([
		"running",
		"exited",
		"cancelled",
		"timed_out",
		"output_limit",
		"interrupted",
		"failed",
	]),
	exitCode: z.number().nullable(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
	bytes: z.number().nonnegative(),
	ready: z.boolean(),
	readyNotified: z.boolean(),
	completionNotified: z.boolean(),
});
export type ProcessRecord = z.infer<typeof recordSchema>;
export interface ProcessNotice {
	readonly id: string;
	readonly processId: string;
	readonly agentId: string;
	readonly kind: "ready" | "completed";
	readonly status: ProcessRecord["status"];
	readonly exitCode: number | null;
	readonly label: string;
	readonly artifact: string;
}
interface Entry {
	record: ProcessRecord;
	child?: ChildProcess;
	done: Promise<void>;
	persistence: Promise<void>;
	storageError: boolean;
}
export interface ProcessOptions {
	readonly rootId: string;
	readonly directory: string;
	/** Resolve only after the notification is durably accepted; retries use stable IDs. */
	readonly notify: (notice: ProcessNotice) => Promise<void>;
	readonly maxRunning?: number;
	readonly maxRetained?: number;
	readonly maxOutputBytes?: number;
	readonly env?: NodeJS.ProcessEnv;
}
export interface ProcessStart {
	readonly agentId: string;
	readonly file: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	readonly label: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
	readonly notifyOnOutput?: string;
	/** Search helpers do not wake the model after returning their own output. */
	readonly notify?: boolean;
}
/** Owns command authority, bounded memory, output artifacts, and an idempotent notification outbox. */
export class HarnessProcesses {
	private entries = new Map<string, Entry>();
	private pending = new Set<Promise<unknown>>();
	private reservations = 0;
	private closed = false;
	constructor(private readonly options: ProcessOptions) {}
	private artifact(id: string): string {
		return join(this.options.directory, `${id}.log`);
	}
	private metadata(id: string): string {
		return join(this.options.directory, `${id}.json`);
	}
	async initialize(): Promise<void> {
		await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
		for (const name of await readdir(this.options.directory)) {
			if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
			let record: ProcessRecord;
			try {
				record = recordSchema.parse(
					JSON.parse(
						await readFile(join(this.options.directory, name), "utf8"),
					),
				);
			} catch {
				continue;
			}
			if (name !== `${record.id}.json`) continue;
			if (record.status === "running") {
				record.status = "interrupted";
				record.finishedAt = Date.now();
			}
			const entry: Entry = {
				record,
				done: Promise.resolve(),
				persistence: Promise.resolve(),
				storageError: false,
			};
			this.entries.set(record.id, entry);
			await this.persist(entry);
			await this.deliver(entry);
			this.evict();
		}
	}
	private persist(entry: Entry): Promise<void> {
		const snapshot = { ...entry.record };
		const operation = entry.persistence
			.catch(() => {})
			.then(async () => {
				const path = this.metadata(entry.record.id);
				await atomicWritePrivateJson(path, snapshot);
			});
		entry.persistence = operation;
		void operation.catch(() => {
			entry.storageError = true;
			this.kill(entry, "failed");
		});
		return operation;
	}
	private async deliver(entry: Entry): Promise<void> {
		for (const kind of ["ready", "completed"] as const) {
			const field = kind === "ready" ? "readyNotified" : "completionNotified";
			if (
				entry.record[field] ||
				(kind === "ready"
					? !entry.record.ready
					: entry.record.status === "running")
			)
				continue;
			try {
				await this.options.notify({
					id: `${entry.record.id}:${kind}`,
					processId: entry.record.id,
					agentId: entry.record.agentId,
					kind,
					status: entry.record.status,
					exitCode: entry.record.exitCode,
					label: entry.record.label,
					artifact: this.artifact(entry.record.id),
				});
				entry.record[field] = true;
				await this.persist(entry);
			} catch {}
		}
	}
	private evict(): void {
		const limit = this.options.maxRetained ?? 128;
		for (const [id, entry] of this.entries) {
			if (this.entries.size <= limit) break;
			if (entry.record.status !== "running" && !entry.child)
				this.entries.delete(id);
		}
	}
	private own(id: string, agentId: string): Entry {
		const entry = this.entries.get(id);
		if (
			!entry ||
			(entry.record.agentId !== agentId && agentId !== this.options.rootId)
		)
			throw new Error("Unknown process for this agent");
		return entry;
	}
	list(agentId: string): ReadonlyArray<ProcessRecord> {
		return [...this.entries.values()]
			.filter(
				(entry) =>
					agentId === this.options.rootId || entry.record.agentId === agentId,
			)
			.map((entry) => ({ ...entry.record }));
	}
	async start(input: ProcessStart): Promise<ProcessRecord> {
		if (this.closed) throw new Error("Process host is closed");
		if (
			this.reservations +
				[...this.entries.values()].filter((entry) => entry.child).length >=
			(this.options.maxRunning ?? 8)
		)
			throw new Error("Running process limit reached");
		this.reservations++;
		const operation = this.launch(input);
		this.pending.add(operation);
		try {
			return await operation;
		} finally {
			this.pending.delete(operation);
			this.reservations--;
		}
	}
	private async launch(input: ProcessStart): Promise<ProcessRecord> {
		input.signal.throwIfAborted();
		const id = randomUUID();
		const handle = await open(this.artifact(id), "wx", 0o600);
		const output = handle.createWriteStream();
		let outputError = false;
		const flushed = finished(output).catch(() => {
			outputError = true;
		});
		const entry: Entry = {
			record: {
				id,
				agentId: input.agentId,
				label: input.label,
				cwd: input.cwd,
				status: "running",
				exitCode: null,
				startedAt: Date.now(),
				finishedAt: null,
				bytes: 0,
				ready: false,
				readyNotified: input.notify === false,
				completionNotified: input.notify === false,
			},
			done: Promise.resolve(),
			persistence: Promise.resolve(),
			storageError: false,
		};
		try {
			await this.persist(entry);
			input.signal.throwIfAborted();
			if (this.closed) throw new Error("Process host is closed");
		} catch (error) {
			entry.record.status = "failed";
			entry.record.finishedAt = Date.now();
			output.end();
			await flushed;
			await this.persist(entry).catch(() => {});
			throw error;
		}
		const child = spawnSupervisedProcess(
			input.file,
			input.args,
			input.cwd,
			Date.now() + SUPERVISED_COMMAND_LEASE_MS,
			{ stdin: true, env: this.options.env, killDescendantsOnExit: true },
		);
		entry.child = child;
		this.entries.set(id, entry);
		const stop = () => this.kill(entry, "cancelled");
		input.signal.addEventListener("abort", stop, { once: true });
		if (input.signal.aborted) stop();
		const heartbeat = setInterval(
			() => child.stdin?.write(`${Date.now() + SUPERVISED_COMMAND_LEASE_MS}\n`),
			5000,
		);
		heartbeat.unref();
		const deadline = setTimeout(
			() => this.kill(entry, "timed_out"),
			input.timeoutMs,
		);
		deadline.unref();
		child.stdin?.on("error", () => this.kill(entry, "failed"));
		const stdin = child.stdio[3];
		if (stdin instanceof Writable) stdin.on("error", () => {});
		output.on("error", () => {
			outputError = true;
			this.kill(entry, "failed");
		});
		const marker = input.notifyOnOutput
			? Buffer.from(input.notifyOnOutput)
			: null;
		let tail = Buffer.alloc(0);
		let readyWork = Promise.resolve();
		const append = (chunk: Buffer) => {
			const remaining =
				(this.options.maxOutputBytes ?? 64 * 1024 * 1024) - entry.record.bytes;
			const accepted = chunk.subarray(0, Math.max(0, remaining));
			entry.record.bytes += accepted.length;
			if (accepted.length && !output.write(accepted)) {
				child.stdout?.pause();
				child.stderr?.pause();
			}
			if (marker && !entry.record.ready) {
				const scan = Buffer.concat([tail, accepted]);
				if (scan.includes(marker)) {
					entry.record.ready = true;
					readyWork = this.persist(entry)
						.then(() => this.deliver(entry))
						.catch(() => {});
				}
				tail = Buffer.from(
					scan.subarray(Math.max(0, scan.length - marker.length + 1)),
				);
			}
			if (chunk.length > remaining) this.kill(entry, "output_limit");
		};
		output.on("drain", () => {
			child.stdout?.resume();
			child.stderr?.resume();
		});
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.once("error", () => this.kill(entry, "failed"));
		entry.done = new Promise<void>((resolve) =>
			child.once("close", (code) => {
				clearInterval(heartbeat);
				clearTimeout(deadline);
				input.signal.removeEventListener("abort", stop);
				entry.child = undefined;
				entry.record.exitCode = code;
				entry.record.finishedAt = Date.now();
				if (entry.record.status === "running")
					entry.record.status = outputError ? "failed" : "exited";
				output.end();
				void (async () => {
					await flushed;
					await readyWork;
					if (outputError) entry.record.status = "failed";
					await this.persist(entry);
					await this.deliver(entry);
					this.evict();
				})()
					.catch(() => {
						entry.storageError = true;
					})
					.finally(resolve);
			}),
		);
		return { ...entry.record };
	}
	private kill(entry: Entry, status: ProcessRecord["status"]): void {
		if (entry.record.status === "running") entry.record.status = status;
		if (entry.child) signalProcessGroup(entry.child, "SIGKILL");
	}
	async output(
		id: string,
		agentId: string,
		cursor = 0,
		maxBytes = 16_000,
	): Promise<{
		process: ProcessRecord;
		text: string;
		next_cursor: number;
		artifact: string;
		storage_error: boolean;
	}> {
		const entry = this.own(id, agentId);
		const handle = await open(this.artifact(id), "r");
		try {
			const size = (await handle.stat()).size;
			if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > size)
				throw new Error("Output cursor is outside the artifact");
			const buffer = Buffer.alloc(Math.min(64_000, Math.max(4, maxBytes)));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);

			let end = bytesRead;
			if (cursor + bytesRead < size || entry.record.status === "running") {
				let start = end - 1;
				while (start >= 0 && ((buffer[start] ?? 0) & 0xc0) === 0x80) start--;
				if (start >= 0) {
					const lead = buffer[start] ?? 0;
					const expected =
						lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
					if (end - start < expected) end = start;
				}
			}
			return {
				process: { ...entry.record },
				text: buffer.subarray(0, end).toString("utf8"),
				next_cursor: cursor + end,
				artifact: this.artifact(id),
				storage_error: entry.storageError,
			};
		} finally {
			await handle.close();
		}
	}
	async wait(
		id: string,
		agentId: string,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<ProcessRecord> {
		const entry = this.own(id, agentId);
		signal.throwIfAborted();
		if (timeoutMs > 0) {
			const timer = new AbortController();
			try {
				await Promise.race([
					entry.done,
					delay(timeoutMs, undefined, {
						signal: AbortSignal.any([signal, timer.signal]),
					}),
				]);
			} finally {
				timer.abort();
			}
		}
		signal.throwIfAborted();
		return { ...entry.record };
	}
	async write(
		id: string,
		agentId: string,
		data: string,
		eof: boolean,
		signal: AbortSignal,
	): Promise<void> {
		const entry = this.own(id, agentId);
		signal.throwIfAborted();
		const stdin = entry.child?.stdio[3];
		if (entry.record.status !== "running" || !(stdin instanceof Writable))
			throw new Error("Process stdin is closed");
		await new Promise<void>((resolve, reject) =>
			stdin.write(data, (error) =>
				error ? reject(new Error("Process stdin is closed")) : resolve(),
			),
		);
		if (eof) stdin.end();
	}
	async stop(id: string, agentId: string): Promise<void> {
		const entry = this.own(id, agentId);
		this.kill(entry, "cancelled");
		await entry.done;
	}
	async interruptAgents(ids: ReadonlyArray<string>): Promise<void> {
		const selected = [...this.entries.values()].filter((entry) =>
			ids.includes(entry.record.agentId),
		);
		for (const entry of selected) this.kill(entry, "cancelled");
		await Promise.all(selected.map((entry) => entry.done));
	}
	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.pending]);
		for (const entry of this.entries.values()) this.kill(entry, "cancelled");
		await Promise.all([...this.entries.values()].map((entry) => entry.done));
		this.entries.clear();
	}
}
