# @openstarry-plugin/standard-function-stdio

CLI text input/output plugin for terminal-based agent interaction.

## Five Aggregates

- **IUI (色蘊)** — renders agent events to terminal (color-coded output)
- **IListener (受蘊)** — reads user input from stdin via readline

## Installation

```bash
pnpm add @openstarry-plugin/standard-function-stdio
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    { "name": "@openstarry-plugin/standard-function-stdio" }
  ]
}
```

No additional configuration required.

> **Note**: Do not use together with `tui-dashboard` — both compete for terminal control.

## Slash Commands

Built-in commands handled by the stdio listener:

| Command | Description |
|---------|-------------|
| `/help` | Show all available slash commands |
| `/reset` | Reset conversation history and unlock safety lockout |
| `/quit` | Gracefully stop the agent and exit |

Additional slash commands from other plugins (e.g., `/provider`, `/devtools`, `/workflow`) are also routed through this listener.

## Terminal Output

Events are color-coded for readability:

| Event | Color | Format |
|-------|-------|--------|
| User message | Blue | `> message` |
| Assistant text | Green | Streaming character-by-character |
| Tool call | Yellow | `[tool] Calling: tool_name` |
| Tool result | Gray (dim) | `[result] ...` (truncated) |
| Error | Red | `[error] message` |
| System | Magenta | `[system] message` |
| Safety lockout | Red bold | `[SAFETY LOCKOUT] message` |
| Thinking | Dim | `[thinking...]` |

## Architecture

### Listener (受蘊)

- Uses Node.js `readline` interface for line-by-line input
- Parses slash commands (prefix `/`) and routes to registered handlers
- Regular text input forwarded via `ctx.pushInput()` to the agent core
- Prompts with `> ` after each agent response cycle

### UI (色蘊)

- Subscribes to all `AgentEvent` types via `onEvent()`
- Handles streaming: `MESSAGE_ASSISTANT_CHUNK` events are written character-by-character
- `MESSAGE_ASSISTANT_COMPLETE` finalizes the stream with a newline
- Manages streaming state to avoid interleaved output

## Development

```bash
pnpm build
pnpm test
```

## See Also

- `@openstarry-plugin/tui-dashboard` — Full-screen terminal dashboard (alternative UI)
- `@openstarry-plugin/transport-websocket` — WebSocket transport (headless alternative)
