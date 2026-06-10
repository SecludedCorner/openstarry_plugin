# @openstarry-plugin/web-ui

Browser-based chat interface for OpenStarry agents. Serves a dark-themed responsive web UI that connects to the agent via WebSocket.

## Five Aggregates

**IUI (色蘊)** — serves the web frontend as a static HTTP server with dynamic config injection.

## Installation

```bash
pnpm add @openstarry-plugin/web-ui
```

## Configuration

Add to your `agent.json` (typically paired with `transport-websocket`):

```json
{
  "plugins": [
    {
      "name": "@openstarry-plugin/transport-websocket",
      "config": {
        "port": 8080,
        "path": "/ws",
        "auth": { "enabled": true, "token": "secret", "allowedOrigins": ["http://localhost:8081"] }
      }
    },
    {
      "name": "@openstarry-plugin/web-ui",
      "config": {
        "port": 8081,
        "host": "0.0.0.0",
        "websocketUrl": "ws://localhost:8080/ws?token=secret",
        "title": "My Agent"
      }
    }
  ]
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `8081` | HTTP server port |
| `host` | `string` | `"0.0.0.0"` | Bind address |
| `websocketUrl` | `string` | `"ws://localhost:8080/ws"` | WebSocket endpoint URL |
| `title` | `string` | `"OpenStarry Agent"` | Page title |

## Usage

1. Start agent with both `transport-websocket` and `web-ui` plugins
2. Open browser to `http://localhost:8081`
3. Chat with the agent in the browser

## Features

- Dark-themed responsive chat UI
- Real-time streaming responses (character-by-character)
- WebSocket auto-reconnect with exponential backoff
- Session persistence across page reloads (via `localStorage`)
- Tool call visualization (yellow-highlighted)
- Error display
- Connection status indicator

## How It Works

### Config Injection

The plugin injects runtime configuration into `index.html` at serve time:

```html
<script>window.__OPENSTARRY_CONFIG__={"websocketUrl":"ws://...","title":"..."};</script>
```

This allows the static JavaScript client to discover the WebSocket endpoint without hardcoding.

### Static Files

The UI consists of three files served from `src/static/`:

| File | Purpose |
|------|---------|
| `index.html` | Page structure and layout |
| `styles.css` | Dark theme styles |
| `app.js` | WebSocket client, message rendering, reconnect logic |

### Security

- Path traversal prevention via `resolveSafePath()` (normalize + resolve + relative check)
- Only `GET` and `HEAD` methods allowed
- Null byte rejection
- Query string and hash stripping

## Development

```bash
pnpm build
pnpm test
```

## See Also

- `@openstarry-plugin/transport-websocket` — Required WebSocket transport backend
- `@openstarry-plugin/http-static` — Generic static file server (if you need custom HTML)
