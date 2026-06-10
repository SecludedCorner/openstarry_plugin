# @openstarry-plugin/provider-gemini

Google AI Gemini provider plugin for OpenStarry agent framework.

## Features

- Google AI / Gemini API with streaming support (API key authentication)
- Multiple Gemini model support (2.0 Flash, 2.5 Pro, 1.5 Pro)
- SSE (Server-Sent Events) streaming
- Function calling (tool use) support
- System instructions support
- Encrypted credential storage using SecureStore
- Slash command interface for authentication

## Installation

```bash
pnpm add @openstarry-plugin/provider-gemini
```

## Usage

### Register the plugin

```typescript
import { createGeminiPlugin } from "@openstarry-plugin/provider-gemini";

const plugin = createGeminiPlugin();
```

### Authenticate

Use the slash command to configure your Google AI API key:

```
/provider login gemini <YOUR_API_KEY>
```

### Check status

```
/provider status
```

### Logout

```
/provider logout gemini
```

or

```
/provider remove gemini
```

## Supported Models

- **gemini-2.0-flash**: Gemini 2.0 Flash (1M context, 8K output)
- **gemini-2.5-pro**: Gemini 2.5 Pro (1M context, 65K output)
- **gemini-1.5-pro**: Gemini 1.5 Pro (2M context, 8K output)

## Security

- API keys are encrypted at rest using AES-256-GCM via SecureStore
- Credentials stored in `~/.openstarry/plugins/gemini/`
- Machine-bound encryption (keys derived from machine ID)

## Get Your API Key

Get your Google AI API key from:
https://aistudio.google.com/app/apikey

## Note

This plugin uses the Google AI API (`generativelanguage.googleapis.com`) with API key authentication. This is different from `@openstarry-plugin/provider-gemini-oauth` which uses Google Code Assist OAuth flow.

## Tool Calling

The provider automatically converts OpenStarry tool schemas to Gemini function declaration format and handles streaming function calls.

## Five Aggregates Classification

- **想 (IProvider)**: LLM service provider

## License

Part of the OpenStarry project.
