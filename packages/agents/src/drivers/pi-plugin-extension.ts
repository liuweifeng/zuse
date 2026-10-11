import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpGatewayHttpServer } from "../mcp-gateway/index.ts";
import { PLUGIN_TOOLS } from "./plugin-tools.ts";

/** Only a revocable loopback session credential is written, never upstream secrets. */
export async function createPiPluginExtension(server: McpGatewayHttpServer) {
	const directory = await mkdtemp(join(tmpdir(), "zuse-pi-plugins-"));
	const file = join(directory, "plugins.mjs");
	try {
		const response = await fetch(new URL("/orchestration", server.url), {
			method: "POST",
			headers: { ...server.headers, "content-type": "application/json" },
			body: JSON.stringify({ name: "tools/list" }),
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok && response.status !== 403)
			throw new Error("Could not discover Zuse orchestration tools.");
		const orchestration = response.ok
			? ((await response.json()) as {
					tools: ReadonlyArray<{
						name: string;
						description: string;
						inputSchema: unknown;
					}>;
				})
			: { tools: [] };
		const tools = [
			...PLUGIN_TOOLS.map((tool) => ({
				...tool,
				endpoint: new URL("/plugins", server.url).href,
			})),
			...orchestration.tools.map((tool) => ({
				...tool,
				endpoint: new URL("/orchestration", server.url).href,
			})),
		];
		await writeFile(
			file,
			`import { Type } from "@earendil-works/pi-ai";
export default function(pi) {
 const headers = ${JSON.stringify(server.headers)};
 for (const tool of ${JSON.stringify(tools)}) {
  pi.registerTool({name:tool.name,label:tool.name,description:tool.description,parameters:Type.Unsafe(tool.inputSchema),
   async execute(_id,args,signal) {
    const response = await fetch(tool.endpoint,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({name:tool.name,args}),signal});
    if (!response.ok) throw new Error("Zuse tool request failed. Check session permissions.");
    return {...await response.json(), details:{}};
   }
  });
 }
}
`,
			{ mode: 0o600 },
		);
		return {
			file,
			close: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
