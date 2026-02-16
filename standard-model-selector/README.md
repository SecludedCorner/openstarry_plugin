# @openstarry-plugin/standard-model-selector

Aggregates `/provider` subcommands for status and model selection.

## Commands

| Command | Description |
|---------|-------------|
| `/provider status` | Show status of all registered providers |
| `/provider model` | List available models from configured providers |
| `/provider model <id>` | Select a model for the current session |

## Architecture

Uses the **handler chain** pattern — multiple plugins register the same `/provider` command name. Each handler returns `undefined` for subcommands it doesn't handle, passing control to the next handler.

This plugin handles `status`, `model`, and `help`. Individual provider plugins handle `login`, `logout`, and `remove` for their respective provider names.

## Service Dependency

Depends on the `cognition-config` service registered by AgentCore to get/set the runtime model selection.
