# @openstarry-plugin/provider-gemini-oauth

Google Gemini LLM provider with PKCE OAuth 2.0 authentication and machine-bound token encryption.

## Five Aggregates

**IProvider (想蘊)** — cognitive processing via Gemini API with streaming support.

## Installation

```bash
pnpm add @openstarry-plugin/provider-gemini-oauth
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    { "name": "@openstarry-plugin/provider-gemini-oauth" }
  ],
  "cognition": {
    "provider": "gemini-oauth",
    "model": "gemini-2.0-flash",
    "temperature": 0.7,
    "maxTokens": 8192
  }
}
```

## Models

| Model | Context Window | Description |
|-------|----------------|-------------|
| `gemini-2.0-flash` | 1M tokens | Fast, general purpose (default) |
| `gemini-1.5-pro` | 2M tokens | Larger context, higher quality |
| `gemini-1.5-flash` | 1M tokens | Fast, cost-effective |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/provider login gemini` | Start OAuth login (opens browser) |
| `/provider logout gemini` | Clear stored credentials |
| `/provider status` | Show auth status and user email |

## OAuth Flow

1. User runs `/provider login gemini`
2. Plugin generates PKCE challenge and opens browser to Google login
3. Local callback server on port 8085 receives auth code
4. Auth code exchanged for access/refresh tokens
5. Tokens encrypted with AES-256-GCM using machine-bound key and stored in `~/.openstarry/plugins/gemini-oauth/`

## Security

- **PKCE**: SHA-256 code challenge prevents auth code interception
- **Machine-bound encryption**: Tokens encrypted with key derived from hostname + username
- **File permissions**: Token files stored with `chmod 600`
- **Auto-refresh**: Access tokens refreshed automatically using stored refresh token

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENSTARRY_GEMINI_PROJECT_ID` | Override auto-provisioned project ID |

## Development

```bash
pnpm build
pnpm test
```

## See Also

- OpenStarry SDK: `IProvider` interface
