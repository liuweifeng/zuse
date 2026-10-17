import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{ name: "fixture", version: "1" },
	{ capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Echo fixture",
			inputSchema: { type: "object", properties: { text: { type: "string" } } },
		},
	],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
	if (params.arguments.text === "crash") process.exit(1);
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
