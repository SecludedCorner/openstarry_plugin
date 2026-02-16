# @openstarry-plugin/transport-http

HTTP REST + SSE transport plugin for programmatic agent access.

## Five Aggregates

- **IListener (受蘊)** — receives user input via HTTP POST
- **IUI (色蘊)** — buffers agent events for polling; also streams events via SSE

## Installation

```bash
pnpm add @openstarry-plugin/transport-http
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    {
      "name": "@openstarry-plugin/transport-http",
      "config": {
        "port": 3000,
        "host": "0.0.0.0",
        "basePath": "/api"
      }
    }
  ]
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `3000` | HTTP server port |
| `host` | `string` | `"0.0.0.0"` | Bind address |
| `basePath` | `string` | `"/api"` | API route prefix |
| `responseBufferSize` | `number` | `100` | Max buffered responses |
| `responseTimeout` | `number` | `300000` | Buffer TTL in ms (5 min) |
| `healthCheck.enabled` | `boolean` | `true` | Enable SSE heartbeat |
| `healthCheck.intervalMs` | `number` | `30000` | Heartbeat interval in ms |

## API Endpoints

### `POST /api/input` — Submit user input

```bash
curl -X POST http://localhost:3000/api/input \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello agent", "sessionId": "optional-session-id"}'
```

Response: `202 Accepted`
```json
{ "status": "accepted", "requestId": "http-1707..." }
```

### `GET /api/response?requestId=xxx` — Poll response

```bash
curl http://localhost:3000/api/response?requestId=http-1707...
```

Response: `200 OK`
```json
{
  "requestId": "http-1707...",
  "events": [...],
  "complete": true
}
```

### `GET /api/events[?sessionId=xxx]` — SSE streaming

```bash
curl -N http://localhost:3000/api/events
```

Server-Sent Events stream:
```
event: agent_event
id: 1
data: {"type":"MESSAGE_ASSISTANT_CHUNK","payload":{"text":"Hello"}}
```

Session-scoped: only events matching the connection's session are forwarded.

### `GET /api/status` — Agent status

```bash
curl http://localhost:3000/api/status
```

Response:
```json
{ "status": "running", "pendingRequests": 0 }
```

## Architecture

- **Request/Response model**: POST input returns a `requestId`; poll with GET to retrieve buffered events
- **SSE model**: Real-time streaming with automatic heartbeat and session filtering
- **CORS**: All origins allowed (`*`) by default
- **Cleanup**: Stale buffered responses are garbage-collected every 60 seconds

## Development

```bash
pnpm build
pnpm test
```

## See Also

- `@openstarry-plugin/transport-websocket` — WebSocket transport (bidirectional, lower latency)
