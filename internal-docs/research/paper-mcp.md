# Paper MCP availability

Verified against first-party documentation on 2026-10-17.

Paper documents a **local desktop MCP integration**. No publicly hosted MCP endpoint is documented; this is a finding about the published integration, not proof that no private service exists. [Paper MCP documentation](https://paper.design/docs/mcp)

- Recommended transport: stdio, launching the Paper CLI with the `mcp` argument. Copy the executable path from Paper Desktop's MCP panel. [Setup instructions](https://paper.design/docs/mcp)
- Legacy transport: Streamable HTTP at `http://127.0.0.1:29979/mcp`, available while Desktop has a file open. This localhost endpoint is not an online service. [Migration instructions](https://paper.design/docs/mcp#updating-from-an-older-setup)
- The CLI exposes tools and instructions even with Desktop closed; document operations still target the file open in Desktop. [CLI behavior](https://paper.design/docs/mcp#why-switch)
- Paper's support docs explicitly describe the server as running over localhost. [Support](https://paper.design/docs/support)

Integration implication (inference): launch local plugin commands on the computer running Paper Desktop. A cloud workspace cannot reach a user's Mac through its own localhost address.

Example configuration; replace the command with the path copied from Paper:

```json
{
  "mcpServers": {
    "paper": {
      "type": "stdio",
      "command": "/path/to/paper",
      "args": ["mcp"]
    }
  }
}
```
