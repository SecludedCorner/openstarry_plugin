# OpenStarry Plugins

Official plugin ecosystem for the [OpenStarry](https://github.com/SecludedCorner/openstarry) AI Agent framework.

[繁體中文](./README_TW.md)

## Overview

This repository contains **50 packages — 49 loadable plugins plus one shared types library (`mcp-common`)** — that extend OpenStarry's capabilities through the **Five Aggregates (五蘊)** architecture. Each plugin is a standalone package following the factory pattern (`createXxxPlugin()` → `IPlugin` with a `manifest` + `factory(ctx)`).

> Canonical aggregate mapping (see the doc repo's [Deep Dive 14](https://github.com/SecludedCorner/openstarry_doc/blob/main/Agent_Core_Components_Deep_Dive/14_Agent_Core_Philosophy_Five_Aggregates.md)): **色 Form = `IRupa` = `IUI` (output) + `IListener` (input)** — a listener is a sense organ, so transports/listeners live under Form, not Sensation. **受 Sensation = `IVedana`** (feedback quality). **想 Perception = `ISamjna` = `IProvider`** (and context managers). **行 Formation = `ISamskara` = `ITool`**. **識 Consciousness = `IVijnana` = `IGuide`** (identity, governance, volition).

## Plugin List

### 色 Form (IRupa — IUI output + IListener input)

| Plugin | Description |
|--------|-------------|
| `web-ui` | Browser chat interface |
| `tui-dashboard` | Terminal UI dashboard (Ink-based) |
| `standard-function-stdio` | Standard I/O listener for CLI interaction |
| `transport-websocket` | WebSocket transport |
| `transport-http` | HTTP/SSE transport |
| `transport-local-cli` | Local CLI transport |
| `http-static` | Static file server |
| `mcp-client` | MCP client (connect to external MCP servers) |
| `mcp-server` | MCP server (expose the agent as an MCP service) |
| `comm-pipeline` | Inter-agent communication channel (verification-layer — see ledger #10) |

### 受 Sensation (IVedana — feedback quality)

| Plugin | Description |
|--------|-------------|
| `vedana-sensor-core` | Three-channel feedback sensing (dukkha / sukha / upekkha) → `createVedanaFn` |

### 想 Perception (ISamjna — providers + context strategy)

| Plugin | Description |
|--------|-------------|
| `provider-claude` | Anthropic Claude (direct API) |
| `provider-claude-cli` | Claude via the local `claude` CLI |
| `provider-chatgpt` | OpenAI ChatGPT (API key) |
| `provider-chatgpt-oauth` | OpenAI ChatGPT (OAuth) |
| `provider-gemini` | Google Gemini (API key) |
| `provider-gemini-oauth` | Google Gemini via OAuth (free tier supported) |
| `provider-lmstudio` | LM Studio (OpenAI-compatible local inference) |
| `provider-local-llama` | Ollama / local llama (native API) |
| `context-sliding-window` | Sliding-window context manager (`IContextManager`) |
| `context-summary` | Summarizing context manager (`IContextManager`) |

### 行 Formation (ISamskara — tools)

| Plugin | Description |
|--------|-------------|
| `standard-function-fs` | File system operations (read, write, list, mkdir, delete) |
| `standard-function-exec` | Guarded command execution (`exec.run`): execFile/no-shell, default-off `allowShell` gate, exact-match allowlist + denylist + shell-metacharacter rejection, emits `tool:blocked` on deny |
| `workflow-engine` | Workflow engine (loop/while steps + disk-backed state) |
| `devtools` | Developer tools (inspect, debug) |
| `agent-ask` | Exposes the cognition loop as a delegable tool (fractal composition, ledger #10) |
| `agent-spawn` | The agent's own loop spawning + managing sub-agents: `agent.spawnChild`, `agent.supervise` (restart-on-crash), `agent.fork`/`agent.branch` (session-snapshot inheritance) — Tenet #10 / Fractal Society; daemon mode only |
| `agent-comm` | Cross-daemon agent↔agent messaging (`agent.send`/`agent.inbox`), request-response (`agent.request`/`agent.reply`), broadcast (`agent.broadcast`), pipeline (`agent.pipeline`), cluster pub/sub (`agent.subscribe`/`agent.events`), service discovery (`agent.register`/`agent.findPeer`) — Tenet #10 C/T1–T4 + pipeline; daemon mode only |
| `comm-channel-p2p` | A real point-to-point `ICommChannel` ('messaging') over the daemon transport — the first live consumer of the `commChannelRegistry` (Doc 53); daemon mode only |
| `confirmation-gate-standard` | Tool-call confirmation gate (approve / deny / ask_user) |
| `comm-proxy` | Fault-isolation decorator (circuit breaker + bulkhead — verification-layer) |

### 識 Consciousness (IVijnana — guides, governance, volition)

| Plugin | Description |
|--------|-------------|
| `guide-character-init` | Character / system-prompt initialization guide |
| `guide-persistent` | Persistent guide state |
| `auditor-threshold` | Confidence threshold auditor |
| `auditor-passthrough` | Pass-through auditor (no-op baseline) |
| `monitor-loop-quality` | Cognitive-loop quality monitor |
| `volition-rule-engine` | Volition deliberation rule engine |
| `standard-function-skill` | Markdown-defined skill execution |
| `api-runtime` | API runtime capability surface |

### Runtime, governance & shared

| Plugin | Description |
|--------|-------------|
| `gear-arbiter-static` | Static dual-gear arbiter (`IGearArbiter`) |
| `gear-arbiter-dynamic` | Dynamic dual-gear arbiter |
| `distributed-alaya` | Cross-process seed store (八識/阿賴耶; N=2 single-host, HMAC-signed, replay-nonce) |
| `vasana-engine` | Habit-energy (習氣) engine |
| `mesh` | Mesh coordination subsystem |
| `spc-monitor` | Statistical-process-control monitor |
| `standard-model-selector` | Model/provider selection service |
| `standard-core-commands` | Built-in slash commands |
| `mcp-common` | **Shared MCP types/constants — a library, not a loadable plugin** (no manifest) |

> Honest scope: `comm-pipeline` / `comm-proxy` / the standalone `openstarry-channel` hub are verification-layer or not on the proven routing path (which is MCP). See the [Tenets Fulfillment Ledger](https://github.com/SecludedCorner/openstarry_doc/blob/main/TENETS_FULFILLMENT.md) #10.

## Usage

This repository sits alongside the `openstarry` core repo:

```
your-workspace/
├── openstarry/            ← Core framework
└── openstarry_plugin/     ← This repo
```

The core's `pnpm-workspace.yaml` includes `../openstarry_plugin/*`, so all plugins are part of the workspace:

```bash
cd openstarry
pnpm install    # Installs everything including plugins
pnpm build      # Builds all packages and plugins
pnpm test       # Runs all tests
```

### Installing plugins via CLI

```bash
node apps/runner/dist/bin.js plugin search fs
node apps/runner/dist/bin.js plugin install standard-function-fs
node apps/runner/dist/bin.js plugin install --all
node apps/runner/dist/bin.js plugin list
```

## Creating a Plugin

Every plugin exports a factory function that returns an `IPlugin`:

```typescript
import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { z } from "zod";

export function createMyPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/my-plugin",
      version: "1.0.0",
      description: "My custom plugin",
      skandha: "samskara",
    },
    factory(ctx: IPluginContext): PluginHooks {
      return {
        tools: [
          {
            name: "my-tool",
            description: "Does something useful",
            parameters: z.object({ input: z.string() }),
            execute: async ({ input }) => ({ success: true, result: input.toUpperCase() }),
          },
        ],
        dispose() { /* cleanup on shutdown */ },
      };
    },
  };
}
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
