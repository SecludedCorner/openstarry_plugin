# @openstarry-plugin/standard-function-skill

Markdown skill file loader with YAML frontmatter parsing for OpenStarry agents.

## Five Aggregates

**ITool (行蘊) + IGuide (識蘊)** — loads skill definitions from `.md` files and registers them as tools and/or guides.

## Installation

```bash
pnpm add @openstarry-plugin/standard-function-skill
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    {
      "name": "@openstarry-plugin/standard-function-skill",
      "config": {
        "skillPath": "./skills"
      }
    }
  ]
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `skillPath` | `string` | `"./skills"` | Path to skill file or directory |

## Skill File Format

Skill files are Markdown with YAML frontmatter:

```markdown
---
name: code-review
description: Review code for quality and security issues
version: 1.0.0
---

You are a code review expert. When reviewing code:

1. Check for security vulnerabilities
2. Evaluate code quality and readability
3. Suggest improvements with examples
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique skill identifier |
| `description` | string | Yes | What the skill does |
| `version` | string | No | Skill version |

## How It Works

1. Plugin reads skill files from `skillPath` (single file or directory)
2. Parses YAML frontmatter and Markdown body
3. Registers each skill as an `IGuide` with the parsed system prompt
4. The agent can switch guides to activate different skills

## Development

```bash
pnpm build
pnpm test    # Tests frontmatter parsing, empty body, format preservation
```

## See Also

- `@openstarry-plugin/guide-character-init` — Default static guide
