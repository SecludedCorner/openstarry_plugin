# @openstarry-plugin/standard-function-fs

Secure filesystem operations toolkit for OpenStarry agents.

## Five Aggregates

**ITool (行蘊)** — executable file system actions with path security enforcement.

## Installation

```bash
pnpm add @openstarry-plugin/standard-function-fs
```

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    { "name": "@openstarry-plugin/standard-function-fs" }
  ],
  "capabilities": {
    "tools": ["fs.read", "fs.write", "fs.list", "fs.mkdir", "fs.delete"],
    "allowedPaths": ["."]
  }
}
```

## Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `fs.read` | Read file contents | `path` (string), `encoding?` (string, default: utf-8) |
| `fs.write` | Write content to file | `path` (string), `content` (string) |
| `fs.list` | List directory contents | `path` (string), `recursive?` (boolean) |
| `fs.mkdir` | Create directory (recursive) | `path` (string) |
| `fs.delete` | Delete file or directory | `path` (string) |

## Security

All paths are validated against `allowedPaths` before any operation:

1. Relative paths resolved against `workingDirectory`
2. Path normalized (removes `.`, `..`, duplicate separators)
3. Validated to be within an allowed path

`SecurityError` is thrown if a path escapes the allowed scope:

```
Path "/etc/passwd" is outside allowed scope. Allowed: /home/user/project
```

## Output Format

`fs.list` output uses `[DIR]` prefix for directories:

```
[DIR] src
[DIR] tests
      index.ts
      package.json
```

## Development

```bash
pnpm build
pnpm test
```

## See Also

- `@openstarry-plugin/standard-function-stdio` — CLI I/O
- `@openstarry-plugin/standard-function-skill` — Skill file loader
