# ADR 0006: Machine-owned local MCP plugins

- Status: Accepted
- Date: 2026-10-17
- Amends: ADR 0005's exclusion of local stdio servers

## Decision

Users can explicitly add local stdio commands in Plugins in their personal workspace. Commands, arguments and environment overrides live in an account-scoped file under the runtime's application data directory, with directory mode 0700 and file mode 0600. They never enter the hosted plugin API or organization catalog.

The local-only `plugins.local.request` RPC requires a local connection identity, a signed-in account, a personal scope and a control-plane runtime. Adding a command verifies MCP initialization and tool discovery before saving it. Writes are serialized and replace the file atomically; malformed persisted files fail closed.

Local and hosted tools share the existing session gateway, tool address shape and permission broker. No driver receives a native MCP configuration. Tool clients are lazy, shared per server, discarded on exit, and closed when disabled, removed or the owning service shuts down. Local search waits at most two seconds for startup and discovery without cancelling the shared client. Startup and background discovery retain their regular thirty-second timeouts; a real failure evicts the affected client and pauses automatic retries for ten seconds. Pending discovery is shared and successful results are cached for thirty seconds, so a slow result can serve the next search. Toggling the connection clears the failure cooldown. Process cleanup runs without extending the search wait limit. Every plugin request revalidates account ownership. Cloud runtimes continue using their existing hosted plugin grants and cannot launch these commands.

## Consequences

Desktop integrations such as Paper can be used by local agents. The binary and desktop application must exist on the same computer as the Zuse runtime. Local plugins require explicit setup on each machine; cloud access to Mac applications is outside this decision. A saved connection indicates a successfully configured server, not continuous upstream application health; failed discovery on one local server does not block other plugins.
