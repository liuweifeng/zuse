import { issueMcpGatewaySession } from "@zuse/agents/mcp-gateway";

const session = await issueMcpGatewaySession({
	sessionId: "gateway-process-lifetime-regression",
	scopes: { browser: false, orchestration: false },
	ctx: {},
});
await session.close();
console.log("gateway-session-cleanup-complete");
// No explicit server close or process.exit: disposing the provider must permit natural exit.
