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
async function discoverTools(client: Client) {
	const tools = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await client.listTools({ cursor }, timeout);
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
	private clients = new Map<string, Promise<Client>>();
	private async disconnect(id: string) {
		const pending = this.clients.get(id);
		this.clients.delete(id);
		if (pending)
			await pending.then(
				(client) => client.close(),
				() => undefined,
			);
	}
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
		run: (client: Client) => Promise<A>,
	): Promise<A> {
		if (this.closed) throw new Error("Local plugins have shut down");
		let pending = this.clients.get(row.id);
		if (!pending) {
			const transport = new StdioClientTransport({
				command: row.command,
				args: row.args,
				env: { ...getDefaultEnvironment(), ...row.env },
				stderr: "ignore",
			});
			const client = new Client({ name: "Zuse", version: "1.0.0" });
			const forget = () => {
				if (this.clients.get(row.id) === pending) this.clients.delete(row.id);
			};
			client.onclose = forget;
			pending = client
				.connect(transport, timeout)
				.then(() => client)
				.catch(async (error) => {
					forget();
					await transport.close();
					throw error;
				});
			this.clients.set(row.id, pending);
		}
		return run(await pending);
	}

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
					await this.withClient(row, discoverTools);
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
			if (input.action === "remove" || !input.enabled)
				await this.disconnect(input.id);
			return { kind: "ok" };
		});
		this.queue = task.catch(() => undefined);
		return task;
	}
	async tools(input: PluginToolRequest): Promise<unknown> {
		await this.queue;
		const rows = (await this.rows()).filter((row) => row.enabled);
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
				offset < rows.length && result.length < 100;
				offset += 4
			) {
				const batch = await Promise.all(
					rows.slice(offset, offset + 4).map(async (row) => {
						try {
							return await this.withClient(row, async (client) => {
								const tools = await discoverTools(client);
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
							});
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
