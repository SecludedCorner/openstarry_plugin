# @openstarry-plugin/mcp-common

Shared types and constants for the Model Context Protocol (MCP) version `2024-11-05`.

## Package Type

**Shared Library** — Not a plugin itself (no factory function). Provides protocol definitions used by `@openstarry-plugin/mcp-client` and `@openstarry-plugin/mcp-server`.

## Installation

```bash
pnpm add @openstarry-plugin/mcp-common
```

## Exports

### Protocol Constants

```typescript
import { PROTOCOL_VERSION, JsonRpcErrorCode, McpErrorCode } from "@openstarry-plugin/mcp-common";

PROTOCOL_VERSION; // "2024-11-05"
JsonRpcErrorCode.METHOD_NOT_FOUND; // -32601
McpErrorCode.SAMPLING_DEPTH_EXCEEDED; // -32002
```

### JSON-RPC Types

```typescript
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "@openstarry-plugin/mcp-common";
```

### MCP Tool Types

```typescript
import type {
  McpToolInfo,
  McpToolResult,
  McpContent,
} from "@openstarry-plugin/mcp-common";
```

### MCP Prompt Types

```typescript
import type {
  McpPromptInfo,
  McpPromptResult,
} from "@openstarry-plugin/mcp-common";
```

### MCP Resource Types

```typescript
import type {
  McpResourceInfo,
  McpResourceResult,
} from "@openstarry-plugin/mcp-common";
```

### MCP Sampling Types (Bidirectional)

```typescript
import type {
  SamplingMessage,
  SamplingRequest,
  SamplingResponse,
  ModelPreferences,
} from "@openstarry-plugin/mcp-common";
```

### MCP Logging Types (Bidirectional)

```typescript
import type {
  McpLogLevel,
  McpLogMessage,
  McpSetLevelRequest,
} from "@openstarry-plugin/mcp-common";
```

### MCP Roots Types (Bidirectional)

```typescript
import type {
  McpRoot,
  McpRootsListResult,
} from "@openstarry-plugin/mcp-common";
```

### MCP Capabilities

```typescript
import type { McpCapabilities } from "@openstarry-plugin/mcp-common";
```

## Protocol Version

This package implements **MCP Specification 2024-11-05** with bidirectional features:
- Tools, Prompts, Resources (core)
- Sampling (server → client LLM requests)
- Logging (server → client structured logs)
- Roots (client → server filesystem boundaries)

## Development

```bash
pnpm build    # Compile TypeScript types
```

## Related Packages

- `@openstarry-plugin/mcp-client` — Connects to external MCP servers
- `@openstarry-plugin/mcp-server` — Exposes OpenStarry tools as MCP server
