# @openstarry-plugin/standard-core-commands

Built-in slash commands for OpenStarry agents.

## Commands

| Command | Description |
|---------|-------------|
| `/help` | List all registered slash commands |
| `/reset` | Reset conversation history for the current session |
| `/quit` | Stop the agent |
| `/metrics` | Show current metrics snapshot (counters + gauges) |

## Usage

This plugin is loaded by default in all agent configurations. It provides the essential commands that were previously hardcoded in AgentCore.

```json
{
  "plugins": [
    { "name": "@openstarry-plugin/standard-core-commands" }
  ]
}
```

## Architecture

Follows the microkernel purity principle (#2, #7): all user-facing commands live in plugins, not in Core. The `/reset` command emits `STATE_RESET` event, which Core's safety monitor listens to for reset.
