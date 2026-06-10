# @openstarry-plugin/tui-dashboard

Full-screen terminal dashboard for monitoring OpenStarry agents in real time.

## Installation

```bash
pnpm add @openstarry-plugin/tui-dashboard
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    { "name": "@openstarry-plugin/tui-dashboard" }
  ]
}
```

> **Note**: The TUI plugin takes over the terminal in full-screen mode. Do not use it together with the `standard-function-stdio` plugin — they will conflict on stdout. Remove or disable stdio when using TUI.

## Layout

```
+--[ OpenStarry ]--------[ [RUN] My Agent v1.0.0 ]--+
|                                    |               |
|  12:30:01 > Hello agent            | Event Log (5) |
|  12:30:02 Processing your request  | [12:30:01] .. |
|  12:30:03 [tool] Calling: read_file| [12:30:02] .. |
|  12:30:04 [result] File contents.. | [12:30:03] .. |
|                                    |               |
+----------------------------------------------------+
| 4 msgs | 1 tools | 0 errors   q=quit Tab=log ...  |
+----------------------------------------------------+
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q` | Quit the dashboard |
| `Tab` | Toggle event log sidebar |
| `Up` / `Down` | Scroll chat messages |
| `[` / `]` | Scroll event log (when visible) |

## Message Types

| Event | Display |
|-------|---------|
| User message | Blue, prefixed with `> ` |
| Assistant message | Green |
| Tool call | Yellow, `[tool] Calling: name` |
| Tool result | Gray, `[result] ...` (truncated to 500 chars) |
| Error | Red, `[error] ...` |
| System | Magenta, `[system] ...` |

## Architecture

This plugin implements the **IUI (色蘊)** interface from the Five Aggregates pattern:

- Receives all `AgentEvent` via `IUI.onEvent()`
- Maps events to UI actions via `eventToAction()`
- Renders with Ink (React for CLI) using `useReducer` + Context
- Read-only monitoring (no input in MVP)

## Development

```bash
pnpm build    # Compile TypeScript
pnpm test     # Run 58 tests
```
