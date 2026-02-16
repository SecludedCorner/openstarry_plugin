# @openstarry-plugin/http-static

Static HTTP file server plugin for serving web assets (HTML, CSS, JS, images) to browser clients.

## Five Aggregates

**IUI (色蘊)** — Serves static files via HTTP, providing web asset delivery without rendering agent events.

## Installation

```bash
pnpm add @openstarry-plugin/http-static
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    {
      "package": "@openstarry-plugin/http-static",
      "config": {
        "host": "0.0.0.0",
        "port": 8081,
        "staticDir": "/path/to/static/files",
        "indexFile": "index.html",
        "mimeTypes": {
          ".webp": "image/webp"
        }
      }
    }
  ]
}
```

### Config Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | `string` | `"0.0.0.0"` | Bind address for HTTP server |
| `port` | `number` | `8081` | Port number for HTTP server |
| `staticDir` | `string` | **(required)** | Absolute path to static files directory |
| `indexFile` | `string` | `"index.html"` | Default file to serve for directory requests |
| `mimeTypes` | `Record<string, string>` | Built-in types | Custom MIME type overrides (extension → type) |

### Built-in MIME Types

Supports common web file types: `.html`, `.css`, `.js`, `.json`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.eot`.

## Security

**Path Traversal Prevention** — Uses `resolveSafePath()` to validate all file paths:
- Decodes URI-encoded characters (blocks `%2e%2e` escapes)
- Rejects null bytes (`\0`)
- Prevents directory traversal (blocks paths outside `staticDir`)
- Returns 403 Forbidden for invalid paths

## Architecture

- Implements passive `IUI` interface (serves files but does not render agent events)
- Supports GET and HEAD methods
- Automatically serves `indexFile` for directory requests
- Returns 405 for non-GET/HEAD requests, 404 for missing files

## Development

```bash
pnpm build    # Compile TypeScript
pnpm test     # Run tests
```

## Related Plugins

- `@openstarry-plugin/web-ui` — Serves browser chat interface using HTTP (pair with `http-static` or use standalone)
- `@openstarry-plugin/transport-websocket` — Provides WebSocket transport for real-time browser communication
