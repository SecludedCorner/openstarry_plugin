# @openstarry-plugin/devtools

Runtime introspection and debugging plugin for OpenStarry agents.

## Installation

```bash
pnpm add @openstarry-plugin/devtools
```

## Usage

```typescript
import { createDevtoolsPlugin } from "@openstarry-plugin/devtools";

const agent = createAgent({
  plugins: [
    createDevtoolsPlugin({
      autoStart: false,
      metricsInterval: 5000,
      maxEventLogSize: 500,
      verbose: false,
    }),
  ],
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoStart` | `boolean` | `false` | Show panel on agent start |
| `metricsInterval` | `number` | `5000` | Metrics snapshot interval (ms) |
| `maxEventLogSize` | `number` | `500` | Max events in circular buffer |
| `verbose` | `boolean` | `false` | Enable verbose debug logging |
| `position` | `"bottom" \| "right"` | `"bottom"` | Panel position hint |
| `size` | `number` | `30` | Panel size percentage |

## Slash Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/devtools` | `/devtools` | Toggle DevTools panel ON/OFF |
| `/metrics` | `/metrics` | Print current metrics snapshot |
| `/debug` | `/debug [on\|off]` | Toggle verbose logging; no args shows current state |

## Architecture

### Five Aggregates Mapping

- **IListener (受蘊)**: `MetricsListener` — subscribes to all agent events via `ctx.bus.onAny()`, increments counters, runs periodic snapshot emission
- **IUI (色蘊)**: `DevToolsUI` — headless panel providing state inspection and view switching

### Headless Design

This plugin uses pure TypeScript classes instead of Ink/React components. This design decision was made for:

1. **Testability**: All components are unit-testable without DOM or React rendering
2. **Independence**: No coupling to tui-dashboard or any specific rendering framework
3. **Composability**: Output is plain data/strings that any UI layer can consume

The panel (`DevToolsPanel`) manages state internally and exposes data via `getState()` and `getLatestState()` methods. A future Ink-based renderer can wrap these data accessors.

### Key Components

- **MetricsCollector**: Map-based storage for counters, gauges, and timing histograms
- **EventLog**: Fixed-size circular buffer preventing unbounded memory growth
- **StateInspector**: Generates `DevToolsState` snapshots from sessions, metrics, and events
- **DevToolsPanel**: View controller with three switchable views (metrics, state, events)

## Security: Sandbox Exception

This plugin runs with `sandbox: { enabled: false }` because it requires:

- `process.memoryUsage()` for heap metrics (blocked in sandboxed mode)
- Direct access to the agent's event bus for comprehensive event capture

This is appropriate for a developer tool that needs full runtime introspection. The plugin does not execute user-provided code or access the filesystem. In production deployments where DevTools is not needed, simply omit this plugin from the plugin list.
