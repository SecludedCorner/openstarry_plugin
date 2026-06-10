# @openstarry-plugin/provider-chatgpt

OpenAI ChatGPT provider plugin for OpenStarry agent framework.

## Features

- OpenAI Chat Completions API with streaming support
- Multiple model support (GPT-4o, GPT-4o Mini, o3-mini, GPT-4 Turbo, GPT-3.5 Turbo)
- Custom base URL for Azure OpenAI or compatible endpoints
- Function calling (tool use) support
- Encrypted credential storage using SecureStore
- Slash command interface for authentication

## Installation

```bash
pnpm add @openstarry-plugin/provider-chatgpt
```

## Usage

### Register the plugin

```typescript
import { createChatGptPlugin } from "@openstarry-plugin/provider-chatgpt";

const plugin = createChatGptPlugin();
```

### Authenticate

Use the slash command to configure your OpenAI API key:

```
/provider login chatgpt <YOUR_API_KEY>
```

For custom endpoints (Azure OpenAI, etc.):

```
/provider login chatgpt <YOUR_API_KEY> <BASE_URL>
```

### Check status

```
/provider status
```

### Logout

```
/provider logout chatgpt
```

or

```
/provider remove chatgpt
```

## Supported Models

- **gpt-4o**: GPT-4o (128K context, 16K output)
- **gpt-4o-mini**: GPT-4o Mini (128K context, 16K output)
- **o3-mini**: o3-mini (200K context, 100K output)
- **gpt-4-turbo**: GPT-4 Turbo (128K context, 4K output)
- **gpt-3.5-turbo**: GPT-3.5 Turbo (16K context, 4K output)

## Security

- API keys are encrypted at rest using AES-256-GCM via SecureStore
- Credentials stored in `~/.openstarry/plugins/chatgpt/`
- Machine-bound encryption (keys derived from machine ID)

## Custom Base URL

Useful for:
- Azure OpenAI endpoints
- Self-hosted OpenAI-compatible APIs (LocalAI, LM Studio, etc.)
- Proxy servers

Example:
```
/provider login chatgpt sk-xxx https://your-api.example.com/v1
```

## Tool Calling

The provider automatically converts OpenStarry tool schemas to OpenAI function format and handles streaming tool calls.

## Five Aggregates Classification

- **想 (IProvider)**: LLM service provider

## License

Part of the OpenStarry project.
