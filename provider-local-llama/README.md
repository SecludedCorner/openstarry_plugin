# @openstarry-plugin/provider-local-llama

Ollama local LLM provider plugin for OpenStarry agent framework.

## Features

- Ollama API with streaming support (local LLM inference)
- Dynamic model discovery (auto-detects installed models)
- NDJSON streaming (not SSE) via Ollama chat API
- Tool calling (function calling) support
- Auto-detect local Ollama instance on startup
- Custom host URL support (for remote Ollama instances)
- No API key required (local service)
- Slash command interface for connection management

## Installation

```bash
pnpm add @openstarry-plugin/provider-local-llama
```

## Prerequisites

- Ollama must be installed and running
- Default URL: `http://127.0.0.1:11434`
- Download Ollama from: https://ollama.ai/

## Usage

### Register the plugin

```typescript
import { createLocalLlamaPlugin } from "@openstarry-plugin/provider-local-llama";

const plugin = createLocalLlamaPlugin();
```

### Connect to Ollama

The plugin auto-detects Ollama at `http://127.0.0.1:11434` on startup. To manually retry or use a custom host:

```
/provider login ollama
```

For custom host URL:

```
/provider login ollama http://your-ollama-host:11434
```

### Refresh model list

After installing new models via `ollama pull`, refresh the available models:

```
/ollama refresh
```

### Check status

```
/provider status
```

### Reset to default host

```
/provider logout ollama
```

or

```
/provider remove ollama
```

## Supported Models

Models are dynamically discovered from your Ollama instance. Common models include:

- **llama3.3**: Llama 3.3
- **qwen2.5**: Qwen 2.5
- **mistral**: Mistral
- **gemma2**: Gemma 2
- **phi4**: Phi 4

Install models via Ollama CLI:

```bash
ollama pull llama3.3
ollama pull qwen2.5
```

## Security

- No API key required (local service)
- Configuration stored in `~/.openstarry/plugins/local-llama/`
- Only stores custom host URL if configured

## NDJSON Streaming

Unlike other providers that use SSE, Ollama uses NDJSON (Newline-Delimited JSON) streaming. Each line is a complete JSON object.

## Tool Calling

The provider automatically converts OpenStarry tool schemas to Ollama function format and handles streaming tool calls.

## Five Aggregates Classification

- **想 (IProvider)**: LLM service provider

## License

Part of the OpenStarry project.
