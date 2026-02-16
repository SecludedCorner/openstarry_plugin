# @openstarry-plugin/mcp-server

Expose OpenStarry tools and guides to external MCP clients (Claude Code, VS Code, etc.) via JSON-RPC 2.0.

## Five Aggregates

**IListener (受蘊)** — receives external JSON-RPC requests from MCP clients.

## Configuration

Add to `agent.json` plugins array:

```json
{
  "package": "@openstarry-plugin/mcp-server",
  "config": {
    "name": "my-agent",
    "version": "1.0.0",
    "transport": "stdio",
    "exposedTools": "*",
    "exposedGuides": "*"
  }
}
```

### Config Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | **(required)** | Server name (exposed in MCP initialize handshake) |
| `version` | `string` | **(required)** | Server version |
| `transport` | `"stdio" \| "http"` | **(required)** | Transport protocol |
| `port` | `number` | `3100` | HTTP port (only for `http` transport) |
| `host` | `string` | `"127.0.0.1"` | HTTP host (only for `http` transport) |
| `exposedTools` | `string[] \| "*"` | `"*"` | Tool IDs to expose, or `"*"` for all |
| `exposedGuides` | `string[] \| "*"` | `"*"` | Guide IDs to expose as prompts, or `"*"` for all |

### Transport Modes

**stdio** — Agent is spawned as a child process. JSON-RPC messages are exchanged over stdin/stdout (line-delimited). Use this when an MCP client (e.g., Claude Code) spawns the agent process directly.

**http** — Agent runs an HTTP server. JSON-RPC requests arrive as POST bodies. Use this for network-accessible MCP servers.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/mcp-server-status` | Show server name, transport, and exposed tool/prompt counts |
| `/mcp-server-tools` | List all tools exposed via MCP |
| `/mcp-server-prompts` | List all prompts exposed via MCP |

## MCP Protocol Support

- Protocol version: `2024-11-05`
- Methods: `initialize`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`
- Bridges: ITool → MCP tool (via `zodToJsonSchema`), IGuide → MCP prompt

## Load Order

This plugin requires tools and guides to be registered by other plugins first. Ensure `mcp-server` is loaded **after** all tool/guide-providing plugins in the plugins array.

## Related Packages

- `@openstarry-plugin/mcp-client` — connects to external MCP servers (the reverse direction)
- `@openstarry-plugin/mcp-common` — shared MCP protocol types and constants
