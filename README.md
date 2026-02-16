# OpenStarry Plugins

Official plugin ecosystem for the [OpenStarry](https://github.com/openstarry/openstarry) AI Agent framework.

[繁體中文](./README_TW.md)

## Overview

This repository contains 15 official plugins that extend OpenStarry's capabilities through the **Five Aggregates** architecture. Each plugin is a standalone package following the factory pattern.

## Plugin List

### Tools (ITool — Formation 行)

| Plugin | Package | Description |
|--------|---------|-------------|
| `standard-function-fs` | `@openstarry-plugin/standard-function-fs` | File system operations (read, write, list, delete) |
| `standard-function-stdio` | `@openstarry-plugin/standard-function-stdio` | Standard I/O for CLI interaction |
| `standard-function-skill` | `@openstarry-plugin/standard-function-skill` | Skill execution (Markdown-defined skills) |
| `devtools` | `@openstarry-plugin/devtools` | Developer tools (inspect, debug) |
| `workflow-engine` | `@openstarry-plugin/workflow-engine` | YAML-based workflow engine |

### Listeners (IListener — Sensation 受)

| Plugin | Package | Description |
|--------|---------|-------------|
| `transport-websocket` | `@openstarry-plugin/transport-websocket` | WebSocket transport layer |
| `transport-http` | `@openstarry-plugin/transport-http` | HTTP/SSE transport layer |
| `http-static` | `@openstarry-plugin/http-static` | Static file server |
| `mcp-client` | `@openstarry-plugin/mcp-client` | MCP client (connect to external MCP servers) |
| `mcp-server` | `@openstarry-plugin/mcp-server` | MCP server (expose agent as MCP service) |

### Providers (IProvider — Perception 想)

| Plugin | Package | Description |
|--------|---------|-------------|
| `provider-gemini-oauth` | `@openstarry-plugin/provider-gemini-oauth` | Google Gemini via OAuth (free tier supported) |

### UI (IUI — Form 色)

| Plugin | Package | Description |
|--------|---------|-------------|
| `tui-dashboard` | `@openstarry-plugin/tui-dashboard` | Terminal UI dashboard (Ink-based) |
| `web-ui` | `@openstarry-plugin/web-ui` | Browser chat interface |

### Guides (IGuide — Consciousness 識)

| Plugin | Package | Description |
|--------|---------|-------------|
| `guide-character-init` | `@openstarry-plugin/guide-character-init` | Character initialization guide |

### Shared

| Plugin | Package | Description |
|--------|---------|-------------|
| `mcp-common` | `@openstarry-plugin/mcp-common` | Shared MCP types and utilities |

## Usage

### With the Core Framework

This repository is designed to sit alongside the `openstarry` core repo:

```
your-workspace/
├── openstarry/            ← Core framework
└── openstarry_plugin/     ← This repo
```

The core's `pnpm-workspace.yaml` includes `../openstarry_plugin/*`, so all plugins are automatically part of the workspace.

```bash
cd openstarry
pnpm install    # Installs everything including plugins
pnpm build      # Builds all packages and plugins
pnpm test       # Runs all tests
```

### Installing Plugins via CLI

```bash
# Search for plugins
node apps/runner/dist/bin.js plugin search fs

# Install a single plugin
node apps/runner/dist/bin.js plugin install standard-function-fs

# Install all official plugins
node apps/runner/dist/bin.js plugin install --all

# List installed plugins
node apps/runner/dist/bin.js plugin list

# Uninstall a plugin
node apps/runner/dist/bin.js plugin uninstall standard-function-fs
```

## Creating a Plugin

Every plugin exports a factory function that returns an `IPlugin`:

```typescript
import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";

export function createMyPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/my-plugin",
      version: "1.0.0",
      description: "My custom plugin",
      aggregates: ["tool"],
    },
    factory(ctx: IPluginContext): PluginHooks {
      return {
        tools: [
          {
            name: "my-tool",
            description: "Does something useful",
            parameters: z.object({ input: z.string() }),
            execute: async ({ input }) => {
              return { success: true, result: input.toUpperCase() };
            },
          },
        ],
        dispose() {
          // Cleanup on shutdown
        },
      };
    },
  };
}
```

Scaffold a new plugin project:

```bash
node apps/runner/dist/bin.js create-plugin my-plugin
```

## License

MIT
