# ADR 0005: Agents receive MCP only through the Zuse gateway

- Status: Accepted
- Date: 2026-10-11
- Supersedes: the native passthrough part of
  [ADR 0032](../../specs/self-orchestration/decisions/0032-mcp-connector-passthrough.md)

## Context

ADR 0032 passed the user's own MCP connectors into agents. The implementation
read native configs (`~/.claude.json`, `.mcp.json`, `~/.codex/config.toml`),
probed and authenticated those servers, stored enable/disable overrides
(`mcpDisabledServers`), and injected them into Claude and Cursor sessions.
Other CLIs loaded their own MCP config independently. The result was a
second, per-provider MCP surface with inconsistent behavior, local-only
credentials, and no organization control.

Managed plugins now cover the same need: catalog plugins and custom remote MCP
servers by URL (OAuth, no auth, or API key), in a personal or organization
workspace, served to every driver through the session gateway
(`packages/agents/src/mcp-gateway`, server name `zuse`). See
[managed plugins](../cloud/managed-plugins.md).

## Decision

1. Agents launched by Zuse get MCP tools only from the Zuse gateway (or, for
   Pi, its gateway-backed plugin extension). Users add other servers through
   Plugins.
2. Zuse no longer reads, lists, probes, authenticates, toggles or passes
   through native MCP configs. The `mcp.*` RPCs, `session.mcp.update`,
   `mcpDisabledServers` (global and repository) and the server-side inventory
   are removed. Old settings files that still carry the key decode unchanged.
3. Each driver suppresses its CLI's own MCP loading where a mechanism is
   verified in the CLI/SDK source, without dropping non-MCP behavior
   (instructions, skills, hooks, auth):

| Driver | Mechanism | Not covered |
| --- | --- | --- |
| Claude | `strictMcpConfig: true` (`--strict-mcp-config`) and `ENABLE_CLAUDEAI_MCP_SERVERS=false`. `settingSources` is unchanged. | — |
| Codex | `config/read` (with layers) before launch; user/system/managed servers get `-c mcp_servers={"<name>"={enabled=false}}`, trusted project servers get per-thread `mcp_servers.<name>.enabled=false`; `features.apps=false`, `features.skill_mcp_dependency_install=false`. Fails open if `config/read` fails. | Plugin-bundled MCP servers (disabling `features.plugins` would also drop plugin skills); dotted project server names; a project Codex trusts for the first time at `thread/start`. |
| Cursor | Every send passes `mcpServers` (possibly `{}`), which makes the SDK build the session MCP lease from inline servers only. `settingSources: ["project"]` still loads rules. | — |
| Gemini | `--allowed-mcp-server-names=zuse`; the ACP-provided server passes the same filter. | — |
| OpenCode | A Zuse plugin's `config` hook deletes every merged `mcp` entry except `zuse`. | `OPENCODE_PURE` (skips plugins); a user plugin that adds servers after ours. |
| OpenCode 2 | None verified. | Native config still loads. |
| Pi | `--no-mcp` (Pi's built-in MCP extension). | Third-party extensions that register MCP servers. |
| Grok | `GROK_{CURSOR,CLAUDE,CODEX}_MCPS_ENABLED=0`, `GROK_MANAGED_MCPS_ENABLED=0`. | `.grok/config.toml`, `.mcp.json` and plugin servers (no switch). |
| Kiro | None verified (closed source). | Native config still loads. |
| Generic ACP agents | None (agent-specific). | Native config may load. |

4. The Codex driver still removes loopback `zuse*` entries that older Zuse
   versions wrote into `~/.codex/config.toml`, before launch.

## Consequences

- One MCP surface, with one permission and audit path, for every provider.
- Servers configured in a provider CLI keep working outside Zuse but are no
  longer visible in Zuse sessions; users re-add them in Plugins.
- Local `stdio` MCP servers are not supported in Zuse sessions.
- The legacy MCP inventory shapes in `packages/contracts/src/mcp.ts` remain
  only until their last renderer consumers are removed.
