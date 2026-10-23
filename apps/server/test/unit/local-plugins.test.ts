import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LocalPlugins,
	withLocalPlugins,
} from "../../src/machine/local-plugins.ts";

const stores: LocalPlugins[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close()));
	vi.restoreAllMocks();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "zuse-local-plugins-"));
	directories.push(directory);
	const store = new LocalPlugins(directory, "account-a");
	stores.push(store);
	return { store, directory };
}
const config = {
	action: "add",
	name: "Paper fixture",
	command: process.execPath,
	args: [resolve(import.meta.dirname, "../fixtures/local-plugin.mjs")],
	env: { LOCAL_PLUGIN_TEST: "test" },
} as const;

describe("local plugins", () => {
	it("discovers and calls stdio tools, persists account-isolated config, and fences disabled/deleted tools", async () => {
		const { store, directory } = await setup();
		const added = await store.request(config);
		if (added.kind !== "attempt") throw new Error("Expected attempt");
		const address = `tools.${added.pluginId}.user.${added.connectionId}.echo`;
		expect(
			await store.tools({ action: "search", query: "paper echo" }),
		).toEqual([{ address, description: "Echo fixture" }]);
		expect(await store.tools({ action: "schema", address })).toMatchObject({
			name: "echo",
			inputSchema: { type: "object" },
		});
		expect(
			await store.tools({
				action: "call",
				address,
				arguments: { text: "hello" },
			}),
		).toMatchObject({ content: [{ type: "text", text: "test:hello" }] });
		await expect(
			store.tools({ action: "call", address, arguments: { text: "crash" } }),
		).rejects.toThrow();
		await expect(
			store.tools({
				action: "call",
				address,
				arguments: { text: "recovered" },
			}),
		).resolves.toMatchObject({ content: [{ text: "test:recovered" }] });
		const resumed = new LocalPlugins(directory, "account-a");
		stores.push(resumed);
		expect((await resumed.snapshot()).catalog).toHaveLength(1);
		await expect(
			resumed.tools({
				action: "call",
				address,
				arguments: { text: "restart" },
			}),
		).resolves.toMatchObject({ content: [{ text: "test:restart" }] });
		expect(
			(await new LocalPlugins(directory, "account-b").snapshot()).catalog,
		).toHaveLength(0);
		expect(
			(await stat(join(directory, (await readdir(directory))[0] ?? "missing")))
				.mode & 0o777,
		).toBe(0o600);
		await store.request({
			action: "setEnabled",
			id: added.connectionId,
			enabled: false,
		});
		expect(await store.tools({ action: "search", query: "" })).toEqual([]);
		await expect(
			store.tools({ action: "call", address, arguments: {} }),
		).rejects.toThrow("disabled");
		await store.request({
			action: "setEnabled",
			id: added.connectionId,
			enabled: true,
		});
		expect(
			await store.tools({
				action: "call",
				address,
				arguments: { text: "again" },
			}),
		).toMatchObject({ content: [{ text: "test:again" }] });
		await store.request({ action: "remove", id: added.connectionId });
		expect((await store.snapshot()).catalog).toHaveLength(0);
	});
	it("does not retain failed commands", async () => {
		const { store } = await setup();
		await expect(
			store.request({ ...config, command: "/nonexistent/zuse-test" }),
		).rejects.toThrow();
		expect((await store.snapshot()).connections).toEqual([]);
	});
	it("combines discovery, preserves outage errors, and checks session ownership", async () => {
		const { store } = await setup();
		const client = withLocalPlugins(store, {
			request: async () => [{ pluginId: "remote" }],
		});
		expect(await client.request({ action: "list" })).toEqual([
			{ pluginId: "remote" },
		]);
		const offline = withLocalPlugins(store, {
			request: async () => {
				throw new Error("Remote offline");
			},
		});
		await expect(offline.request({ action: "list" })).rejects.toThrow(
			"Remote offline",
		);
		const revoked = withLocalPlugins(
			store,
			{ request: async () => [] },
			async () => {
				throw new Error("Account changed");
			},
		);
		await expect(revoked.request({ action: "list" })).rejects.toThrow(
			"Account changed",
		);
		await store.close();
		await expect(store.request(config)).rejects.toThrow("shut down");
	});
	it.each([
		"connect",
		"list",
	])("returns remote results promptly and cleans up stalled %s clients on the regular timeout", async (mode) => {
		const { store, directory } = await setup();
		const stall = join(directory, "stall");
		const starts = join(directory, "starts");
		await writeFile(stall, "");
		await writeFile(starts, "");
		for (let index = 0; index < 5; index++)
			await store.request({
				...config,
				name: `Server ${index}`,
				env: {
					...config.env,
					LOCAL_PLUGIN_STALL_FILE: stall,
					LOCAL_PLUGIN_START_LOG: starts,
				},
			});
		let searching = store;
		if (mode === "connect") {
			await store.close();
			searching = new LocalPlugins(directory, "account-a");
			stores.push(searching);
		}
		await writeFile(stall, mode);
		// Keep the real stdio transport, shortening only the regular SDK timeout for this test.
		if (mode === "connect") {
			const connect = Client.prototype.connect;
			vi.spyOn(Client.prototype, "connect").mockImplementation(function (
				this: Client,
				transport,
				options,
			) {
				return connect.call(this, transport, {
					...options,
					timeout: 3000,
					maxTotalTimeout: 3000,
				});
			});
		} else {
			const listTools = Client.prototype.listTools;
			vi.spyOn(Client.prototype, "listTools").mockImplementation(function (
				this: Client,
				params,
				options,
			) {
				return listTools.call(this, params, {
					...options,
					timeout: 3000,
					maxTotalTimeout: 3000,
				});
			});
		}

		const client = withLocalPlugins(searching, {
			request: async () => [{ address: "remote.tool" }],
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				client.request({ action: "search", query: "" }),
				new Promise((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(
									"Local discovery blocked remote results for over 3 seconds",
								),
							),
						3000,
					);
				}),
			]);
			expect(result).toEqual([{ address: "remote.tool" }]);
			const pids = (await readFile(starts, "utf8"))
				.trim()
				.split("\n")
				.map(Number);
			const stalled = mode === "connect" ? pids.slice(5) : pids.slice(0, 4);
			expect(stalled).toHaveLength(4);
			for (const pid of stalled)
				expect(() => process.kill(pid, 0)).not.toThrow();
			await expect
				.poll(
					() =>
						stalled.every((pid) => {
							try {
								process.kill(pid, 0);
								return false;
							} catch {
								return true;
							}
						}),
					{ timeout: 5000 },
				)
				.toBe(true);
			await writeFile(stall, "");
			const next = await client.request({ action: "search", query: "" });
			expect(next).toHaveLength(2); // The fifth server is healthy; failed servers are cooling down.
			const count = (await readFile(starts, "utf8")).trim().split("\n").length;
			expect(count).toBe(mode === "connect" ? 10 : 5);
		} finally {
			clearTimeout(timer);
			// Also make the pre-fix regression release hung initialization immediately.
			const pids = (await readFile(starts, "utf8"))
				.trim()
				.split("\n")
				.map(Number);
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					/* Already closed. */
				}
			}
		}
	}, 15000);
	it.each([
		"connect",
		"list",
	])("keeps slow %s work and concurrent calls alive after the search stops waiting", async (mode) => {
		const { store, directory } = await setup();
		const stall = join(directory, "slow");
		const starts = join(directory, "slow-starts");
		await writeFile(stall, "");
		await writeFile(starts, "");
		const added = await store.request({
			...config,
			env: {
				...config.env,
				LOCAL_PLUGIN_STALL_FILE: stall,
				LOCAL_PLUGIN_START_LOG: starts,
			},
		});
		if (added.kind !== "attempt") throw new Error("Expected attempt");
		const address = `tools.${added.pluginId}.user.${added.connectionId}.echo`;
		let searching = store;
		if (mode === "connect") {
			await store.close();
			searching = new LocalPlugins(directory, "account-a");
			stores.push(searching);
		}
		await writeFile(stall, `slow-${mode}`);
		const client = withLocalPlugins(searching, {
			request: async () => [{ address: "remote.tool" }],
		});
		const search = client.request({ action: "search", query: "" });
		await expect
			.poll(
				async () => (await readFile(starts, "utf8")).trim().split("\n").length,
			)
			.toBe(mode === "connect" ? 2 : 1);
		const call = searching
			.tools({
				action: "call",
				address,
				arguments: { text: mode === "connect" ? "hello" : "slow" },
			})
			.then(
				(value) => ({ value }),
				(error) => ({ error }),
			);
		expect(await search).toEqual([{ address: "remote.tool" }]);
		expect(await call).toMatchObject({
			value: {
				content: [{ text: mode === "connect" ? "test:hello" : "test:slow" }],
			},
		});
		expect(await client.request({ action: "search", query: "" })).toEqual([
			{ address, description: "Echo fixture" },
			{ address: "remote.tool" },
		]);
	}, 12000);
});
