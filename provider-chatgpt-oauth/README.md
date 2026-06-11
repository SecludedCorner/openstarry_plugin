# @openstarry-plugin/provider-chatgpt-oauth

ChatGPT Provider using OpenAI Codex OAuth (PKCE) — Prototype Implementation

## Overview

This provider enables OpenStarry agents to access OpenAI's ChatGPT models via OAuth 2.0 (Proof Key for Code Exchange) authentication. Instead of API keys, users authenticate through a browser-based OAuth flow that grants secure access to the provider.

## Authentication Flow

The provider implements a 3-step PKCE flow:

1. **Generate Challenge**: Create a code verifier and challenge locally
2. **Browser OAuth**: Open `https://auth.openai.com/authorize` with challenge
3. **Callback Receiver**: Local HTTP server on `localhost:1455` receives the authorization code
4. **Token Exchange**: Exchange code for access token (no user credentials stored)

```
Agent → Browser → auth.openai.com → localhost:1455/callback → Agent Storage
```

## Setup

### Prerequisites

- ChatGPT Plus, Pro, or Team subscription (required for Codex access)
- OpenAI account with OAuth app registered
- Local network access to `localhost:1455`

### Installation

```bash
pnpm install @openstarry-plugin/provider-chatgpt-oauth
```

### Configuration

Add to `agent.json`:

```json
{
  "plugins": [
    {
      "name": "@openstarry-plugin/provider-chatgpt-oauth",
      "config": {
        "clientId": "YOUR_CLIENT_ID",
        "clientSecret": "YOUR_CLIENT_SECRET"
      }
    }
  ]
}
```

Then in the agent:

```
> /provider login chatgpt-oauth
```

Your browser will open an OAuth consent screen. Grant access, and the token will be stored in `~/.openstarry/secure/providers/chatgpt-oauth.json`.

## Supported Models

| Model ID | Description | Availability |
|----------|-------------|--------------|
| `gpt-5.1-codex-mini` | GPT-5.1 Codex Mini (fast inference) | ChatGPT Plus+ |
| `gpt-5.1` | GPT-5.1 (default reasoning) | ChatGPT Plus+ |
| `gpt-5.2-codex` | GPT-5.2 Codex (code focus) | ChatGPT Pro+ |
| `gpt-5.4-mini` | GPT-5.4 Mini (balanced) | ChatGPT Pro+ |
| `gpt-5.4` | GPT-5.4 (full reasoning) | ChatGPT Pro/Team |

Set in `agent.json`:

```json
{
  "cognition": {
    "provider": "chatgpt-oauth",
    "model": "gpt-5.4"
  }
}
```

## Usage

### Interactive Login

```
> /provider login chatgpt-oauth
Opening browser at https://auth.openai.com/authorize?...
[Waiting for OAuth callback...]
✓ Authentication successful
Authenticated as: user@example.com
```

### Check Status

```
> /provider status
chatgpt-oauth: authenticated (expires in 89 days)
Current model: gpt-5.4
```

### Logout

```
> /provider logout chatgpt-oauth
✓ Credentials cleared (local token deleted)
```

### Remove Provider

```
> /provider remove chatgpt-oauth
✓ Provider config removed
```

## Known Limitations

1. **No Temperature Parameter**: The Codex API does not expose temperature control. Reasoning flavor is baked into the model name (e.g., `gpt-5.2-codex` for more code-focused output).

2. **Tool Name Sanitization**: Dots (`.`) in tool names are automatically converted to underscores (`_`) due to OpenAI API restrictions:
   - `fs.read` → `fs_read`
   - `db.query` → `db_query`

3. **Token Expiry**: OAuth tokens expire periodically. The provider automatically handles refresh via stored `refresh_token`. If manual re-auth is needed: `/provider logout chatgpt-oauth && /provider login chatgpt-oauth`

4. **No Streaming**: Codex API returns full completions only (no token-by-token streaming).

5. **Regional Restrictions**: OAuth may not work in countries where OpenAI services are restricted.

## Status

**Prototype** — Not yet formally planned into a release cycle. This provider is experimental and may change significantly before Production release.

### Future Work

- [ ] Streaming token support (if OpenAI Codex API adds it)
- [ ] Temperature equivalent parameters (e.g., via system prompt adjustments)
- [ ] Batch request API support
- [ ] Cost tracking and usage quotas

## Troubleshooting

### OAuth Callback Not Received

**Problem**: Browser opens, you grant access, but agent hangs on "Waiting for OAuth callback..."

**Solutions**:
1. Check firewall: Ensure `localhost:1455` is not blocked
2. Browser redirect: Some browsers may not auto-redirect. Check browser console for errors
3. Manual code entry: Use `--code` flag to manually paste the auth code:
   ```
   /provider login chatgpt-oauth --code AUTH_CODE_FROM_URL
   ```

### "Invalid Client ID"

**Problem**: `/provider login chatgpt-oauth` fails with "Invalid Client ID"

**Solution**: Verify that the `clientId` and `clientSecret` in `agent.json` match your OpenAI OAuth app registration. Get them from [OpenAI Developer Dashboard](https://platform.openai.com/account/applications).

### "Subscription Required"

**Problem**: Agent responds "This model requires ChatGPT Pro subscription"

**Solution**: Upgrade your OpenAI account, or select a lower-tier model available to your subscription level.

## API Reference

### Factory Export

```typescript
export const createChatGptOAuthPlugin: IPluginFactory = (ctx) => ({
  manifest: {
    name: '@openstarry-plugin/provider-chatgpt-oauth',
    type: 'samjna',  // IProvider (cognition aggregate)
    version: '1.0.0-prototype',
    required: false  // optional, degraded if missing
  },
  factory: (ctx) => new ChatGptOAuthProvider(ctx)
});
```

### Provider Interface

Implements `IProvider`:

```typescript
interface IChatGptOAuthProvider extends IProvider {
  authenticate(clientId: string, clientSecret: string): Promise<void>;
  isAuthenticated(): boolean;
  getModels(): Promise<string[]>;
  chat(messages: ChatMessage[], model: string): Promise<string>;
}
```

## Security Notes

- **Token Storage**: OAuth tokens are encrypted using Node.js `crypto` and stored in `~/.openstarry/secure/` with restricted file permissions (0600).
- **PKCE**: All OAuth flows use PKCE (Proof Key for Code Exchange) to prevent authorization code interception.
- **No Credentials in Config**: `clientSecret` should NOT be hardcoded in `agent.json` for production. Use environment variables or use-case-specific app credentials.

## See Also

- [OpenAI OAuth Documentation](https://platform.openai.com/docs/guides/oauth)
- [Doc 57: Multi-Agent Communication Interface Spec](../share/openstarry_doc/Architecture_Documentation/57_Multi_Agent_Communication_Interface_Spec.md)
- [Provider Plugin Development](../docs/EN/plugin-development.md)
