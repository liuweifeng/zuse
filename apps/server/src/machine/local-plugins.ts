import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PluginClient } from "@zuse/agents/drivers/plugin-tools";
import {
	type LocalPluginRequest,
	PluginDefinition,
	type PluginResponse,
	type PluginSnapshot,
	type PluginToolRequest,
} from "@zuse/contracts";
import { Schema } from "effect";

const LocalServerSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	command: Schema.String,
	args: Schema.Array(Schema.String),
	env: Schema.Record(Schema.String, Schema.String),
	enabled: Schema.Boolean,
	createdAt: Schema.Number,
});

interface LocalServer {
	id: string;
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	enabled: boolean;
	createdAt: number;
}
const prefix = (row: LocalServer) => `tools.${row.id}.user.${row.id}.`;
const timeout = { timeout: 30_000, maxTotalTimeout: 30_000 };
const SEARCH_TIMEOUT_MS = 2_000;
const DISCOVERY_RETRY_MS = 10_000;
const DISCOVERY_CACHE_MS = 30_000;
interface DiscoveryBudget {
	readonly signal: AbortSignal;
}
interface LocalClient {
	readonly client: Client;
	readonly transport: StdioClientTransport;
	ready: Promise<Client>;
	discovery?: {
		result: Promise<Awaited<ReturnType<typeof discoverTools>>>;
		expiresAt: number;
	};
}

/** Bound waiting for an already-started connection without leaving an abort listener behind. */
async function withinDeadline<A>(
	pending: Promise<A>,
	signal: AbortSignal,
): Promise<A> {
	let onAbort = () => {};
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Discovery has its own regular timeout, independent of any search waiting for it. */
async function discoverTools(client: Client) {
	const signal = AbortSignal.timeout(timeout.timeout);
	const tools = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await client.listTools({ cursor }, { ...timeout, signal });
		tools.push(...page.tools);
		cursor = page.nextCursor;
		if (cursor && seen.has(cursor))
			throw new Error("MCP server repeated its tool cursor");
		if (cursor) seen.add(cursor);
	} while (cursor && tools.length < 1000 && seen.size < 10);
	return tools.slice(0, 1000);
}

/** One store per signed-in account on this machine; no commands or env sent upstream. */
export class LocalPlugins {
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	private clients = new Map<string, LocalClient>();
	private failedUntil = new Map<string, number>();
	private async disconnect(id: string, entry = this.clients.get(id)) {
		if (!entry) return;
		if (this.clients.get(id) === entry) this.clients.delete(id);
		try {
			await entry.client.close();
		} finally {
			await entry.transport.close();
		}
	}

	/** Stop all child processes and prevent this account store from launching more. */
	async close() {
		this.closed = true;
		await Promise.all(
			[...this.clients.keys()].map((id) => this.disconnect(id)),
		);
	}

	constructor(
		private readonly directory: string,
		private readonly subject: string,
	) {}
	private get path() {
		return join(
			this.directory,
			`${createHash("sha256").update(this.subject).digest("hex")}.json`,
		);
	}
	private async rows(): Promise<LocalServer[]> {
		try {
			return Schema.decodeUnknownSync(Schema.Array(LocalServerSchema))(
				JSON.parse(await readFile(this.path, "utf8")),
			).map((row) => ({ ...row, args: [...row.args], env: { ...row.env } }));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
	private async save(rows: LocalServer[]) {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const temp = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify(rows), { mode: 0o600 });
		await rename(temp, this.path);
	}
	private async withClient<A>(
		row: LocalServer,
		run: (client: Client, entry: LocalClient) => Promise<A>,
		budget?: DiscoveryBudget,
	): Promise<A> {
		if (this.closed) throw new Error("Local plugins have shut down");
		budget?.signal.throwIfAborted();
		let entry = this.clients.get(row.id);
		if (!entry) {
			const transport = new StdioClientTransport({
				command: row.command,
				args: row.args,
				env: { ...getDefaultEnvironment(), ...row.env },
				stderr: "ignore",
			});
			const client = new Client({ name: "Zuse", version: "1.0.0" });
			const created: LocalClient = {
				client,
				transport,
				ready: Promise.resolve(client),
			};
			const forget = () => {
				if (this.clients.get(row.id) === created) this.clients.delete(row.id);
			};
			client.onclose = forget;
			created.ready = client
				.connect(transport, timeout)
				.then(() => client)
				.catch((error) => {
					forget();
					void transport.close().catch(() => undefined);
					throw error;
				});
			this.clients.set(row.id, created);
			entry = created;
		}
		const activeEntry = entry;
		const operation = entry.ready
			.then((client) => run(client, activeEntry))
			.catch((error) => {
				// A true startup/discovery failure owns eviction, even after its search returned.
				if (budget) {
					this.failedUntil.set(row.id, Date.now() + DISCOVERY_RETRY_MS);
					void this.disconnect(row.id, activeEntry).catch(() => undefined);
				}
				throw error;
			});
		return budget ? withinDeadline(operation, budget.signal) : operation;
	}

	/** Share pending discovery and briefly retain late results for subsequent searches. */
	private discover(entry: LocalClient) {
		if (entry.discovery && entry.discovery.expiresAt > Date.now())
			return entry.discovery.result;
		const discovery: NonNullable<LocalClient["discovery"]> = {
			result: discoverTools(entry.client),
			expiresAt: Infinity,
		};
		discovery.result = discovery.result.then((tools) => {
			discovery.expiresAt = Date.now() + DISCOVERY_CACHE_MS;
			return tools;
		});
		entry.discovery = discovery;
		return discovery.result;
	}

	/** Saved connections are account-scoped metadata, not a live upstream health probe. */
	async snapshot(): Promise<PluginSnapshot> {
		const rows = await this.rows();
		return {
			kind: "snapshot",
			canManage: true,
			tenantId: `personal:${this.subject}`,
			tenants: [],
			endpoint: "",
			catalog: rows.map((row) =>
				Schema.decodeUnknownSync(PluginDefinition)({
					id: row.id,
					name: row.name,
					description: `Local MCP · ${row.command}`,
					custom: true,
				}),
			),
			connections: rows.map((row) => ({
				id: row.id,
				pluginId: row.id,
				label: row.name,
				owner: "user",
				state: "connected",
				createdAt: row.createdAt,
				enabled: row.enabled,
			})),
		};
	}
	/** Serialize mutations and verify new commands before saving them atomically. */
	request(input: LocalPluginRequest): Promise<PluginResponse> {
		const task = this.queue.then(async (): Promise<PluginResponse> => {
			if (this.closed) throw new Error("Local plugins have shut down");
			if (input.action === "list") return this.snapshot();
			const rows = await this.rows();
			if (input.action === "add") {
				const name = input.name.trim();
				const command = input.command.trim();
				if (
					!name ||
					name.length > 60 ||
					!command ||
					command.includes("\0") ||
					rows.length >= 50
				)
					throw new Error("Invalid local MCP configuration");
				const row: LocalServer = {
					id: `local-${randomUUID()}`,
					name,
					command,
					args: [...input.args],
					env: { ...input.env },
					enabled: true,
					createdAt: Date.now(),
				};
				// Verify initialization and discovery before keeping a command.
				try {
					await this.withClient(row, (client) => discoverTools(client));
					await this.save([...rows, row]);
				} catch (error) {
					await this.disconnect(row.id);
					throw error;
				}
				return {
					kind: "attempt",
					id: row.id,
					connectionId: row.id,
					pluginId: row.id,
					state: "connected",
					authorizationUrl: null,
					expiresAt: Date.now(),
					error: null,
				};
			}
			const row = rows.find((row) => row.id === input.id);
			if (!row) throw new Error("Local MCP unavailable");
			await this.save(
				input.action === "remove"
					? rows.filter((row) => row.id !== input.id)
					: rows.map((row) =>
							row.id === input.id ? { ...row, enabled: input.enabled } : row,
						),
			);
			this.failedUntil.delete(input.id);
			if (input.action === "remove" || !input.enabled)
				await this.disconnect(input.id);
			return { kind: "ok" };
		});
		this.queue = task.catch(() => undefined);
		return task;
	}
	/** Serve gateway operations; search has a shared deadline and a failure cooldown. */
	async tools(input: PluginToolRequest): Promise<unknown> {
		const budget =
			input.action === "search"
				? {
						signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
					}
				: undefined;
		if (budget) await withinDeadline(this.queue, budget.signal);
		else await this.queue;
		const saved = budget
			? await withinDeadline(this.rows(), budget.signal)
			: await this.rows();
		const rows = saved.filter((row) => row.enabled);
		if (input.action === "list")
			return rows.map((row) => ({
				connectionId: row.id,
				pluginId: row.id,
				label: row.name,
			}));
		if (input.action === "search") {
			const terms = input.query
				.slice(0, 200)
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);
			const result = [];
			// Bound process startup during discovery across many configured servers.
			for (
				let offset = 0;
				offset < rows.length && result.length < 100 && !budget?.signal.aborted;
				offset += 4
			) {
				const batch = await Promise.all(
					rows.slice(offset, offset + 4).map(async (row) => {
						if ((this.failedUntil.get(row.id) ?? 0) > Date.now()) return [];
						try {
							return await this.withClient(
								row,
								async (_client, entry) => {
									const tools = await this.discover(entry);
									return tools
										.filter((tool) =>
											terms.every((term) =>
												`${row.name} ${tool.name} ${tool.description ?? ""}`
													.toLowerCase()
													.includes(term),
											),
										)
										.map((tool) => ({
											address: prefix(row) + tool.name,
											description: tool.description,
										}));
								},
								budget,
							);
						} catch {
							return [];
						}
					}),
				);
				result.push(...batch.flat());
			}
			return result.slice(0, 100);
		}
		const row = rows.find((row) => input.address.startsWith(prefix(row)));
		if (!row) throw new Error("Local MCP unavailable or disabled");
		const name = input.address.slice(prefix(row).length);
		return this.withClient(row, async (client) => {
			if (input.action === "call")
				return client.callTool(
					{ name, arguments: input.arguments },
					undefined,
					timeout,
				);
			const tool = (await discoverTools(client)).find(
				(tool) => tool.name === name,
			);
			if (tool) return tool;
			throw new Error("Local MCP tool unavailable");
		});
	}
}

/** Preserve the same gateway tools and permission broker for both transports. */
export const withLocalPlugins = (
	local: LocalPlugins,
	remote: PluginClient,
	authorize: () => Promise<void> = async () => {},
): PluginClient => ({
	async request(input) {
		await authorize();
		if (input.action === "call" || input.action === "schema")
			return input.address.startsWith("tools.local-")
				? local.tools(input)
				: remote.request(input);
		const [a, b] = await Promise.allSettled([
			local.tools(input),
			remote.request(input),
		]);
		const results = [a, b].flatMap((result) =>
			result.status === "fulfilled" && Array.isArray(result.value)
				? result.value
				: [],
		);
		if (results.length === 0) {
			if (b.status === "rejected") throw b.reason;
			if (a.status === "rejected") throw a.reason;
		}
		return results;
	},
});
