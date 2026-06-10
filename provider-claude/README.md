# @openstarry-plugin/provider-claude

Anthropic Claude provider plugin for OpenStarry agent framework.

## Features

- Anthropic Messages API with streaming support
- Multiple Claude model support (Sonnet 4, Opus 4, Haiku 4.5)
- SSE (Server-Sent Events) streaming
- Tool calling (function calling) support
- Thinking/reasoning blocks support
- Encrypted credential storage using SecureStore
- Slash command interface for authentication

## Installation

```bash
pnpm add @openstarry-plugin/provider-claude
```

## Usage

### Register the plugin

```typescript
import { createClaudePlugin } from "@openstarry-plugin/provider-claude";

const plugin = createClaudePlugin();
```

### Authenticate

Use the slash command to configure your Anthropic API key:

```
/provider login claude <YOUR_API_KEY>
```

### Check status

```
/provider status
```

### Logout

```
/provider logout claude
```

or

```
/provider remove claude
```

## Supported Models

- **claude-sonnet-4-20250514**: Claude Sonnet 4 (200K context, 16K output)
- **claude-opus-4-20250514**: Claude Opus 4 (200K context, 16K output)
- **claude-haiku-4-5-20251001**: Claude Haiku 4.5 (200K context, 8K output)

## Security

- API keys are encrypted at rest using AES-256-GCM via SecureStore
- Credentials stored in `~/.openstarry/plugins/claude/`
- Machine-bound encryption (keys derived from machine ID)

## API Key Format

Anthropic API keys start with `sk-ant-`. Get your API key from:
https://console.anthropic.com/

## Tool Calling

The provider automatically converts OpenStarry tool schemas to Anthropic Messages format and handles streaming tool calls, including thinking/reasoning blocks.

## Five Aggregates Classification

- **想 (IProvider)**: LLM service provider

## License

Part of the OpenStarry project.
