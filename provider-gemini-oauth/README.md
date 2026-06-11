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
    {
      "name": "@openstarry-plugin/provider-gemini-oauth",
      "config": {
        "projectId": "openstarry-491612"
      }
    }
  ],
  "cognition": {
    "provider": "gemini-oauth",
    "model": "gemini-2.0-flash",
    "temperature": 0.7,
    "maxTokens": 8192
  }
}
```

**`projectId` is REQUIRED** (cycle 03-21 hotfix v0.55.2-alpha). Google API rule:
OAuth-authenticated calls to `generativelanguage.googleapis.com` MUST include
the `X-Goog-User-Project` header to specify which GCP project quota is billed
against. The plugin reads `projectId` from (in order):

1. `OPENSTARRY_GEMINI_PROJECT_ID` env var (overrides config)
2. `agent.json` plugin `config.projectId`
3. Managed-project provisioning (auto-discovered if `/provider login gemini-oauth` provisioned a project)

If none resolves, inference fails fast with an operator-actionable error.

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

## OAuth Scopes (cycle 03-21 hotfix v0.55.1-alpha)

The plugin requests the following Google OAuth scopes during PKCE login:

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/cloud-platform` | Inference (`generateContent` / `streamGenerateContent`) and future Gemini API surface |
| `openid` | Identity assertion |
| `https://www.googleapis.com/auth/userinfo.email` | Account email lookup |
| `https://www.googleapis.com/auth/userinfo.profile` | Account profile metadata |

**Migration note (v0.55.1-alpha)**: pre-hotfix releases requested
`generative-language.tuning` which only permits fine-tuning (training) — NOT
inference. After upgrading, Master MUST delete the cached token and re-login:

```bash
rm ~/.openstarry/plugins/gemini-oauth/oauth_token.json
# then re-run:
/provider login gemini-oauth
```

The Google Cloud Console OAuth client MUST whitelist `cloud-platform` in its
OAuth consent screen before re-login succeeds. If not whitelisted, re-register
a new client and rebake `oauth-client.enc.json`.

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
