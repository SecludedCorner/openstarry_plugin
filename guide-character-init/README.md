# @openstarry-plugin/guide-character-init

Default system prompt and persona provider for OpenStarry agents.

## Five Aggregates

**IGuide (識蘊)** — provides the agent's base persona and behavioral instructions as a system prompt.

## Installation

```bash
pnpm add @openstarry-plugin/guide-character-init
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    { "name": "@openstarry-plugin/guide-character-init" }
  ]
}
```

No additional configuration required. The plugin provides a sensible default system prompt.

## Default Behavior

When loaded, the plugin registers a guide with ID `default-guide` that instructs the agent to:

- Act as a helpful AI assistant
- Use available tools to read, write, and manage files
- Explain actions before and after tool use
- Handle errors gracefully with alternative approaches
- Be concise and helpful

## Architecture

This plugin implements the factory pattern:

1. `createGuideCharacterInitPlugin()` returns an `IPlugin`
2. The factory exports a single `IGuide` instance
3. Core retrieves the system prompt via `guide.getSystemPrompt()`

The guide is registered once during initialization and remains static throughout the agent lifecycle.

## Development

```bash
pnpm build
pnpm test
```

## See Also

- `@openstarry-plugin/standard-function-skill` — Dynamic skill loader with Markdown frontmatter
