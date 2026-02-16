# @openstarry-plugin/provider-lmstudio

LM Studio provider plugin for OpenStarry — connects to a local [LM Studio](https://lmstudio.ai/) server via its OpenAI-compatible API.

## Features

- Fetches available models dynamically from `/v1/models` on login
- Remembers connection URL across sessions (encrypted storage)
- SSE streaming for real-time responses
- No API key required (local server)

## Usage

```
/provider login lmstudio                           # Connect to default (127.0.0.1:1234)
/provider login lmstudio http://192.168.1.100:1234/v1  # Custom URL
/provider model llama-3.2-1b-instruct              # Select a model
/provider status                                    # Check connection
/provider logout lmstudio                           # Disconnect
```

## Requirements

- LM Studio running with at least one model loaded
- Server API enabled in LM Studio settings
