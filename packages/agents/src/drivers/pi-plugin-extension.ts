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
		await writeFile(
			file,
			`import { Type } from "@earendil-works/pi-ai";
export default function(pi) {
 const endpoint = ${JSON.stringify(new URL("/plugins", server.url).href)};
 const headers = ${JSON.stringify(server.headers)};
 for (const tool of ${JSON.stringify(PLUGIN_TOOLS)}) {
  pi.registerTool({name:tool.name,label:tool.name,description:tool.description,parameters:Type.Object(Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key,schema])=>[key,schema.type === "string" ? Type.String() : Type.Record(Type.String(),Type.Unknown())])),{additionalProperties:false}),
   async execute(_id,args,signal) {
    const response = await fetch(endpoint,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({name:tool.name,args}),signal});
    if (!response.ok) throw new Error("Plugin request failed. Check the connection in Zuse.");
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
