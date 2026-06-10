# @openstarry-plugin/transport-websocket

WebSocket transport plugin with token authentication, CORS validation, and health monitoring.

## Five Aggregates

- **IListener (受蘊)** — receives user messages via WebSocket
- **IUI (色蘊)** — pushes agent events to connected WebSocket clients

## Installation

```bash
pnpm add @openstarry-plugin/transport-websocket
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    {
      "name": "@openstarry-plugin/transport-websocket",
      "config": {
        "port": 8080,
        "host": "0.0.0.0",
        "path": "/ws",
        "auth": {
          "enabled": true,
          "token": "my-secret-token",
          "allowedOrigins": ["http://localhost:8081"],
          "trustedProxies": ["127.0.0.1"]
        }
      }
    }
  ]
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `8080` | WebSocket server port |
| `host` | `string` | `"0.0.0.0"` | Bind address |
| `path` | `string` | `"/ws"` | WebSocket endpoint path |
| `auth.enabled` | `boolean` | `false` | Enable token authentication |
| `auth.token` | `string` | - | Static auth token (or use `OPENSTARRY_WS_TOKEN` env var) |
| `auth.allowedOrigins` | `string[]` | - | CORS whitelist (`["*"]` for all) |
| `auth.trustedProxies` | `string[]` | - | IPs trusted for X-Forwarded-For |
| `healthCheck.enabled` | `boolean` | `true` | Enable WebSocket ping/pong |
| `healthCheck.intervalMs` | `number` | `30000` | Ping interval in ms |
| `healthCheck.staleThreshold` | `number` | `2` | Missed pongs before disconnect |

## Authentication

### Token Validation

Clients authenticate via query parameter or Authorization header:

```
ws://localhost:8080/ws?token=my-secret-token
```

Or:
```
Authorization: Bearer my-secret-token
```

Token is matched against `auth.token` config or `OPENSTARRY_WS_TOKEN` environment variable.

### CORS Validation

Browser clients must have their `Origin` header in the `allowedOrigins` whitelist.

### Reverse Proxy Support

Behind a proxy (nginx, etc.), the plugin reads the real client IP from:
1. `X-Forwarded-For` header (if sender IP is in `trustedProxies`)
2. `X-Real-IP` header (if sender IP is in `trustedProxies`)
3. Direct `socket.remoteAddress` (fallback)

## Client Protocol

### Connection

On connect, server sends:
```json
{ "type": "connected", "clientId": "ws-uuid", "sessionId": "session-uuid" }
```

### Send Message

```json
{ "type": "user_input", "payload": { "text": "Hello agent" } }
```

### Resume Session

Include `sessionId` in any message to rebind to an existing session:
```json
{ "type": "user_input", "sessionId": "previous-session-id", "payload": { "text": "Continue" } }
```

### Receive Events

```json
{ "type": "agent_event", "event": { "type": "MESSAGE_ASSISTANT_CHUNK", "payload": { "text": "Hi" } } }
```

### Application Ping/Pong

```json
{ "type": "ping" }
```
Response: `{ "type": "pong", "timestamp": 1707... }`

## Session Management

- Each new connection creates a new session
- Clients can resume sessions by sending `sessionId`
- Sessions are destroyed when the last connection disconnects
- Events are routed by `sessionId` (session-scoped) or `replyTo` (client-scoped)

## Health Check

Protocol-level WebSocket ping/pong:
- Server pings all connections at `healthCheck.intervalMs`
- Connections missing `staleThreshold` consecutive pongs are terminated

## Development

```bash
pnpm build
pnpm test    # Unit tests + auth + proxy tests
```

## See Also

- `@openstarry-plugin/web-ui` — Browser frontend that connects via this transport
- `@openstarry-plugin/transport-http` — HTTP REST alternative
