# @openstarry-plugin/mcp-client

Connects to external MCP (Model Context Protocol) servers and imports their tools, prompts, and resources into OpenStarry as ITool and SlashCommand instances.

## Five Aggregates

**IProvider (想蘊)** — Provides external tools/prompts/resources by bridging MCP servers into the OpenStarry ecosystem.

## Installation

```bash
pnpm add @openstarry-plugin/mcp-client
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    {
      "package": "@openstarry-plugin/mcp-client",
      "config": {
        "servers": [
          {
            "name": "filesystem",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
          },
          {
            "name": "github",
            "transport": "http",
            "url": "http://localhost:3100/mcp",
            "oauth": {
              "enabled": true,
              "authUrl": "https://github.com/login/oauth/authorize",
              "tokenUrl": "https://github.com/login/oauth/access_token",
              "clientId": "YOUR_CLIENT_ID",
              "clientSecret": "YOUR_CLIENT_SECRET",
              "scopes": ["repo"]
            }
          }
        ]
      }
    }
  ]
}
```

### Server Config Options

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique server identifier |
| `transport` | `"stdio" \| "http"` | Transport protocol type |
| `command` | `string` | Executable path (stdio only) |
| `args` | `string[]` | Command arguments (stdio only) |
| `env` | `Record<string, string>` | Environment variables (stdio only) |
| `url` | `string` | Server URL (http only) |
| `headers` | `Record<string, string>` | HTTP headers (http only) |
| `oauth` | `McpOAuthConfig` | OAuth 2.1 configuration (http only) |

## Features

### MCP Bridges

1. **Tools Bridge** — External MCP tools → `ITool` instances
   - Tool ID format: `{serverName}/{toolName}`
   - Schema conversion: JSON Schema → Zod
   - Results mapped to OpenStarry format

2. **Prompts Bridge** — External MCP prompts → Slash commands
   - Command format: `/mcp:{serverName}:{promptName}`
   - Supports prompt arguments
   - Returns formatted content

3. **Resources Bridge** — External MCP resources → Slash commands
   - Command format: `/mcp-resource:{serverName}:{resourceName}`
   - Reads resource content via URI

### Bidirectional Handlers

**Sampling** — MCP server requests LLM completion from OpenStarry (anti-recursion depth tracking)
**Logging** — MCP server sends structured logs (forwarded to OpenStarry event bus)
**Roots** — OpenStarry declares filesystem roots to MCP server

## Slash Commands

| Command | Description |
|---------|-------------|
| `/mcp-status` | List all MCP server connection states |
| `/mcp-tools` | List all tools from connected MCP servers |
| `/mcp-prompts` | List all prompts from connected MCP servers |
| `/mcp-resources` | List all resources from connected MCP servers |
| `/mcp-loglevel <server> <level>` | Set log level for specific MCP server |

## Architecture

- Uses `@openstarry-plugin/mcp-common` for protocol types
- Supports stdio (child process) and HTTP transports
- Emits events: `MCP_SERVER_CONNECTED`, `MCP_TOOL_REGISTERED`, `MCP_PROMPT_REGISTERED`
- OAuth tokens stored encrypted via `EncryptedTokenStorage`

## Development

```bash
pnpm build    # Compile TypeScript
pnpm test     # Run tests
```

## Related Packages

- `@openstarry-plugin/mcp-server` — Exposes OpenStarry tools to external MCP clients (reverse direction)
- `@openstarry-plugin/mcp-common` — Shared MCP protocol types and constants
