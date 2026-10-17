import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const stallMode = async () =>
	process.env.LOCAL_PLUGIN_STALL_FILE
		? readFile(process.env.LOCAL_PLUGIN_STALL_FILE, "utf8")
		: "";
if (process.env.LOCAL_PLUGIN_START_LOG)
	await appendFile(process.env.LOCAL_PLUGIN_START_LOG, `${process.pid}\n`);
if ((await stallMode()) === "connect") {
	process.stdin.resume();
	await new Promise(() => {});
}

if ((await stallMode()) === "slow-connect") await delay(2500);

const server = new Server(
	{ name: "fixture", version: "1" },
	{ capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
	if ((await stallMode()) === "list") await new Promise(() => {});
	if ((await stallMode()) === "slow-list") await delay(2500);
	return {
		tools: [
			{
				name: "echo",
				description: "Echo fixture",
				inputSchema: {
					type: "object",
					properties: { text: { type: "string" } },
				},
			},
		],
	};
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
	if (params.arguments.text === "crash") process.exit(1);
	if (params.arguments.text === "slow") await delay(5000);
	return {
		content: [
			{
				type: "text",
				text: `${process.env.LOCAL_PLUGIN_TEST}:${params.arguments.text}`,
			},
		],
	};
});
await server.connect(new StdioServerTransport());
