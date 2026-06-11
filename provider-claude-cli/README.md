# @openstarry-plugin/provider-claude-cli

Claude CLI subprocess provider — wraps the local `claude` binary
(Anthropic Claude Code) via `claude -p` print mode. Inherits the user's
existing OAuth/Pro session; **no auth setup required**, **no key material
handled** by this plugin.

## Five Aggregates

**IProvider (想蘊)** — cognitive processing via Claude CLI subprocess.

## Prerequisites

- Install the CLI: `npm install -g @anthropic-ai/claude-code`
- Authenticate once: `claude auth login` (browser OAuth Pro/Max) or set `ANTHROPIC_API_KEY`
- Verify: `claude auth status`

## Configuration

Add to your `agent.json`:

```json
{
  "plugins": [
    {
      "name": "@openstarry-plugin/provider-claude-cli",
      "config": {
        "model": "sonnet",
        "effort": "medium",
        "maxTurns": 1,
        "timeout": 60000
      }
    }
  ],
  "cognition": {
    "provider": "claude-cli",
    "model": "sonnet"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `"sonnet"` | Model alias (`sonnet`/`opus`/`haiku`) or full id (`claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`) |
| `effort` | (skipped) | `low`/`medium`/`high`/`max`/`auto` reasoning-effort hint forwarded as `--effort` |
| `maxTurns` | `1` | Subprocess `--max-turns` cap (1 = pure inference, no agentic loop) |
| `timeout` | `60000` | Subprocess kill threshold (ms) |

## Process-Level Isolation Guarantees (5-point)

This plugin provides Tier-0 isolation guarantees per Master directive
cycle 03-21 in-flight 2026-05-03. Violation of any point is a critical bug.

1. **Fresh subprocess per call** — every `chat()` invocation spawns a brand-new
   `claude` process; no state carry across calls.
2. **OAuth-compatible isolation triple enforced** (HOTFIX v4 v0.55.4-alpha):
   - `--system-prompt <minimal>` — overrides any inherited `CLAUDE.md` /
     user-prompt context with a one-line "inference-engine" persona.
   - `--strict-mcp-config --mcp-config <empty.json>` — points the subprocess
     at an empty MCP server map written to OS tmpdir, skipping MCP discovery.
   - `--disable-slash-commands` — skills cannot be invoked.

   *(`--bare` was removed because it requires `ANTHROPIC_API_KEY` and is
   incompatible with the Pro/Max OAuth session inherited from `claude auth login`.)*
3. **`--disallowedTools` enforced** — Bash, Read, Edit, Write, WebSearch,
   WebFetch, Grep, Glob, NotebookEdit are all disabled. The OpenStarry agent
   loop manages tools; the CLI subprocess provides text inference only.
4. **`--no-session-persistence` enforced** — no session log written to disk.
5. **No settings-file mutation** — the plugin NEVER touches `~/.claude/*`,
   `.claude/*`, or any related configuration. The empty MCP file lives at
   `<os.tmpdir()>/openstarry-claude-cli-mcp-empty-<pid>.json` (per-PID isolated).
   Communication is strictly `argv` + `stdin/stdout` + inherited environment
   variables.

These guarantees ensure your interactive Claude session (or any parallel
`claude` CLI sessions) remain unaffected by this plugin's subprocesses.

## Models

| Alias | Description |
|-------|-------------|
| `sonnet` | Latest Claude Sonnet (default) |
| `opus`   | Latest Claude Opus |
| `haiku`  | Latest Claude Haiku |

Full model identifiers (e.g., `claude-sonnet-4-6`) are accepted directly.

## Function Calling

**Not supported** by this plugin. The CLI's stream-json output does not
expose a tool schema usable by OpenStarry's agent loop. The plugin
advertises text-only inference; the OpenStarry agent loop falls back
appropriately.

For W2-R26 verification scope (deterministic NEG/POS cases + σ_regime
composition_index), text-only inference is sufficient.

## Cycle 03-25 M3 Security Fixes (v0.57.2-alpha)

Per Master directive 2026-05-07 + Master Ratification Batch 22 14/14 APPROVED,
this plugin received the M3 P1+P2+P4 = 9-finding security fix. **ε-surface
invariance Δ=0 preserved** (no manifest / provider-id / model list / schema
/ HMAC posture changes — internal behaviour fixes only).

### P1 — Critical defenses

- **F-CY25-§4-R1-07** Claude CLI major-version pin (defense-in-depth):
  `AUDITED_CLI_MAJORS` constant captures CLI major versions whose tool-set
  has been security-audited against the 9-tool `--disallowedTools` list.
  When the live binary reports a major version outside this set, the
  adapter warn-logs a re-audit-required event (operator-aware; not a hard
  block). The 9-tool disallow-list remains in effect as second layer.
- **F-CY25-§4-R1-08** unknown stream-event line types are NO LONGER silently
  dropped: `mapStreamEvent` accepts an optional `onUnknown(lineType)`
  callback; production caller (`streamClaudeCli`) warn-logs the unknown
  type. Stream stays alive (defensive — novel CLI versions don't break
  inference).

### P2 — Important defenses

- **F-CY25-§4-R1-01** PATH-shadowing safe binary resolution: `cliPath` is
  resolved to an absolute filesystem path at adapter init via `resolveClaudeBinary()`
  (PATH-walk + `realpathSync`). Subprocess never sees a relative path that
  a malicious earlier-PATH `claude` could shadow.
- **F-CY25-§4-R1-03** subprocess env is an explicit ALLOWLIST
  (`ALLOWED_ENV_KEYS`) — only env vars `claude` provably needs (HOME / PATH
  / locale / OAuth dirs / TMPDIR / Windows essentials / explicit Anthropic
  auth) are forwarded. Agent-side application secrets are dropped.
- **F-CY25-§4-R2-04** multi-turn forward-gap warn: adapter init warns when
  `cfg.maxTurns > 1` is configured (subprocess agentic loop runs internally;
  OpenStarry agent loop cannot inspect intermediate state — re-audit
  required for any consumer relying on per-turn observability).

### P4 — Documentation (this section)

#### Prompt Channel + Role-Prefix Injection (F-CY25-§4-R1-06 + F-CY25-§4-R2-02)

The Claude CLI exposes a single positional prompt argument (`-p <prompt>`).
This plugin's `collapseToPrompt()` serializes the multi-message
`ChatRequest.messages` + optional `ChatRequest.systemPrompt` into a single
transcript with `System: ` / `User: ` / `Assistant: ` line prefixes.

**Caller contract**: app-supplied messages only. If a hostile assistant
message contains a literal `\n\nUser: ...` sentinel, it could spoof a new
user turn within the collapsed prompt. The OpenStarry agent loop is
trusted to pass only application-controlled content; downstream consumers
embedding untrusted user input MUST sanitize role-prefix sentinels before
passing into `chat()`.

#### Empty MCP Config File mode 0o600 (F-CY25-§4-R2-06)

The empty MCP config file (`<os.tmpdir()>/openstarry-claude-cli-mcp-empty-<pid>.json`,
content `{"mcpServers": {}}`) is created with file mode `0o600` (owner
read+write only). Same-host info-leak via the empty config file is
mitigated. The file lives at OS tmpdir and is per-PID isolated — parallel
processes do not collide.

#### HMAC Posture — Leaf Provider Non-Participation (F-CY25-§4-R1-09)

This plugin is a **leaf provider** in the Plan52~Plan60 isomorph topology.
It does NOT participate in the OpenStarry HMAC-SHA256 + nonce + replay-cache
attestation chain (no `psh:` / `ac9:` / `mvq:` / `vsn:` / `msh:` / `apr:` /
`aly:` prefix is registered for this plugin). The Claude CLI subprocess
provides text inference only; it does not deposit seeds, route mesh
messages, queue volitions, or invoke the API runtime.

The 5-point process-level isolation guarantees (`--system-prompt` +
`--strict-mcp-config` + `--disable-slash-commands` + `--disallowedTools` +
`--no-session-persistence` + no settings-file mutation) provide the local
defense surface for this plugin. HMAC participation would require a
non-leaf integration (forward-binding; not in scope).

## Cycle 03-27 Hygiene Fixes (v0.57.4-alpha)

Per Master directive 2026-05-09 §3.1 PASS path — 5 LOW-tier P3 items
deferred from cycle 03-25 R3 §4. ε-surface Δ=0 preserved (no manifest /
provider-id / model-list / schema / HMAC posture change).

| Item | Scope | Symbol |
|------|-------|--------|
| F-CY25-§4-R1-02 | stderr disclosure redaction (sk- / Bearer / ANTHROPIC_*=) + truncation 500 → 200 | `redactStderrForError` |
| F-CY25-§4-R1-04 | subprocess `cwd = tmpdir()` codified as testable export (was implicit in v0.57.2) | `getSubprocessCwd` |
| F-CY25-§4-R1-05 | per-PID `mcp-empty-${pid}.json` unlinked via `process.on("exit")` + dispose() | `cleanupEmptyMcpConfigPath` |
| F-CY25-§4-R2-03 | plugin `dispose()` invokes cleanup + resets cached path | `dispose()` wire |
| F-CY25-§4-R2-05 | `resolveClaudeBinary` memoized at module scope (PATH-shadow fan-out → 1/input) | `_resolveBinaryCache` |

These are hygiene refinements; no security defect is fixed by them
individually — they tighten the defense-in-depth surface already
established by the cycle 03-25 M3 P1+P2+P4 work.

## Stream-JSON Schema (HOTFIX v5 v0.55.5-alpha)

The plugin parses `claude -p --output-format stream-json --include-partial-messages`
ndjson output per the schema documented in Hermes SKILL.md (line 149-163):

| Line type | Shape | OpenStarry event |
|-----------|-------|-------------------|
| `stream_event` | `{type:"stream_event", event:{delta:{type:"text_delta", text:"…"}}}` | `{type:"text_delta", text}` |
| `result` (success) | `{type:"result", subtype:"success", is_error:false, result:"<full text>", session_id, num_turns, total_cost_usd, …}` | `{type:"finish", stopReason:"end_turn"}` |
| `result` (error) | `{type:"result", subtype:"error_max_turns" \| "error_*", is_error:true, …}` | `{type:"error", error: Error("Claude CLI error: <subtype>")}` |
| `system` / `api_retry` | informational | silently skipped |

The `result.result` string is the full aggregated response text — already
streamed via `stream_event` deltas, so the plugin only emits a `finish`
on it (rather than re-yielding the whole text).

## Error Handling

| Condition | Behaviour |
|-----------|-----------|
| `claude` binary not found | Emits `error` event with install instructions |
| Subprocess exit code ≠ 0 | Emits `error` event with stderr snippet |
| Subprocess hang > timeout | Kills process; emits timeout error |
| Stream JSON parse error | Logs warning; continues (best-effort) |
| Empty subprocess output | Emits `error` event |

## Development

```bash
pnpm build
pnpm test
```

## See Also

- OpenStarry SDK: `IProvider` interface
- Hermes orchestration guide: `claude research/人類資料區/學習資料/hermes agent skill for claude/SKILL.md`
- Claude Code reference: <https://code.claude.com/docs/en/cli-reference>
