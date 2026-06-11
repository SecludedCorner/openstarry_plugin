/**
 * provider-claude-cli — Claude CLI subprocess provider plugin.
 *
 * NEW plugin (cycle 03-21 hotfix v3 v0.55.3-alpha; W2-R26 5th unblock).
 * Wraps the local `claude` CLI (Anthropic Claude Code) via `claude -p` print
 * mode subprocess; inherits Master's existing OAuth/Pro session — no auth
 * setup, no key material handled by the plugin.
 *
 * Five Aggregates: IProvider (想蘊) — cognitive processing.
 *
 * **CRITICAL — 5-point Process-Level Isolation Guarantees** (per Master
 * directive cycle 03-21 in-flight 2026-05-03; violation = Tier 0 critical bug):
 *
 *   1. Each inference call spawns a fresh `claude` subprocess (no state carry).
 *   2. OAuth-compatible isolation triple (`--system-prompt` + `--strict-mcp-config
 *      --mcp-config <empty>` + `--disable-slash-commands`) skips user/project
 *      settings, CLAUDE.md, hooks, and MCP discovery without requiring API key.
 *   3. `--disallowedTools` enumerates ALL built-in tools so the OpenStarry
 *      agent loop manages tools — the subprocess provides text inference only.
 *   4. `--no-session-persistence` ensures no session log written to disk.
 *   5. The plugin NEVER modifies user/project settings files (`~/.claude/*`,
 *      `.claude/*`); communication is strictly argv + stdin/stdout + an
 *      explicit env-allowlist (cycle 03-25 M3 P2-03 fix). Master's coordinator
 *      session and any parallel `claude` CLI sessions remain unaffected.
 *
 * **Cycle 03-25 M3 P1+P2+P4 9-finding security fix** (v0.57.2-alpha; per
 * Master directive 2026-05-07 + Master Ratification Batch 22 14/14 APPROVED):
 *
 *   - P1-07: defense-in-depth Claude CLI major-version pin (`AUDITED_CLI_MAJORS`)
 *     in addition to `--disallowedTools` 9-tool list. Re-audit triggered when
 *     subprocess CLI major version is outside the audited set.
 *   - P1-08: `mapStreamEvent` no longer silently drops unknown line types —
 *     surfaces them via an optional `onUnknown(lineType)` callback so the
 *     calling streamer can warn-log (stream stays alive; defensive).
 *   - P2-01: `cliPath` resolved to an ABSOLUTE path at adapter init via
 *     `resolveClaudeBinary()` (PATH-walk + `realpathSync`); subprocess never
 *     sees a relative path that PATH-shadowing could reroute.
 *   - P2-03: subprocess env is an explicit ALLOWLIST (`ALLOWED_ENV_KEYS`) —
 *     only the env vars `claude` provably needs (HOME / PATH / locale / OAuth
 *     dirs / TMPDIR) are forwarded; everything else (including agent-side
 *     application secrets) is dropped.
 *   - P2-04: multi-turn forward-gap guard — adapter init warns when
 *     `cfg.maxTurns > 1` is configured (operator-aware re-audit trigger).
 *   - P4-06/09/R2-02/R2-06: README docs (companion; this file links to them).
 *
 * **Cycle 03-27 hygiene-only fix (v0.57.4-alpha; per Master directive
 * 2026-05-09 §3.1 PASS path; 5 LOW P3 items deferred from cycle 03-25 R3 §4):
 *
 *   - F-CY25-§4-R1-02 (LOW): `redactStderrForError()` strips known-sensitive
 *     substrings (sk-*, Bearer *, ANTHROPIC_*=*) and tightens the truncation
 *     cap 500 → 200 before stderr is forwarded into upstream `Error.message`.
 *   - F-CY25-§4-R1-04 (LOW): subprocess cwd codified via exported
 *     `getSubprocessCwd()` returning `tmpdir()`. Implicit cwd inheritance
 *     would let `claude` discover ancestor `.claude/settings.local.json`;
 *     pinning to tmpdir guarantees no `.claude/` chain exists above the
 *     subprocess. Was already in place since v0.57.2-alpha P2-03 spawn block;
 *     this fix codifies the invariant as a testable export.
 *   - F-CY25-§4-R1-05 (LOW): `cleanupEmptyMcpConfigPath()` unlinks the
 *     per-PID `mcp-empty-${pid}.json` file. Registered as one-shot
 *     `process.on("exit")` handler at file creation time; previously stale
 *     per-PID files accumulated in tmpdir across process generations.
 *   - F-CY25-§4-R2-03 (LOW): plugin `dispose()` now calls
 *     `cleanupEmptyMcpConfigPath()` (which also resets the cached path) so a
 *     runtime reload after dispose triggers a fresh write rather than
 *     reusing a possibly-removed-by-exit-handler path.
 *   - F-CY25-§4-R2-05 (LOW): `resolveClaudeBinary()` is memoized at module
 *     scope (`_resolveBinaryCache`) so concurrent adapter inits sharing the
 *     same `cliPath` resolve once. Caps PATH-shadow re-evaluation fan-out
 *     at 1 per unique input string (vs N-fold under parallel subagent
 *     dispatch). Pairs with F-CY25-§4-R1-01 mitigation.
 *
 * ε-surface invariance Δ=0 PRESERVED: no manifest field change, no
 * provider-id change, no model-list change, no `ChatRequest` /
 * `ProviderStreamEvent` schema change, no HMAC posture change. New
 * exports (`redactStderrForError`, `STDERR_REDACT_MAX_LEN`,
 * `getSubprocessCwd`, `cleanupEmptyMcpConfigPath`,
 * `__resetResolveClaudeBinaryCacheForTests`) are internal helpers /
 * test hooks (same shape as M3 cycle 03-25 internal exports), not
 * IProvider surface changes.
 *
 * **ε-surface invariance Δ=0 hard constraint** (per O3 §6): no manifest field
 * changes, no provider-id changes, no model list changes, no `ChatRequest` /
 * `ProviderStreamEvent` schema changes, no HMAC participation status change
 * (this is a leaf provider — non-participant by design). Internal behaviour
 * fixes only.
 *
 * @see openstarry_doc/Technical_Specifications/ (TBD post-Master Ratification)
 * @see claude research/人類資料區/學習資料/hermes agent skill for claude/SKILL.md
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createLogger } from "@openstarry/shared";
import type {
  ChatRequest,
  IPlugin,
  IPluginContext,
  IProvider,
  Message,
  ModelInfo,
  PluginHooks,
  ProviderStreamEvent,
} from "@openstarry/sdk";

// ─── Models (per Claude CLI --model flag) ───

const MODELS: ModelInfo[] = [
  { id: "sonnet", name: "Claude Sonnet (latest)" },
  { id: "opus", name: "Claude Opus (latest)" },
  { id: "haiku", name: "Claude Haiku (latest)" },
];

// ─── Plugin Config ───

interface ClaudeCliConfig {
  /** Override default model (alias or full id). */
  readonly model?: string;
  /** Effort hint forwarded as `--effort`; auto-skipped when undefined. */
  readonly effort?: "low" | "medium" | "high" | "max" | "auto";
  /** Max-turns cap (default 1; pure inference; no agentic loop). */
  readonly maxTurns?: number;
  /** Subprocess timeout in milliseconds (default 60_000). */
  readonly timeout?: number;
  /** Test-only: override the binary path (default `"claude"`). */
  readonly cliPath?: string;
}

// ─── Message → prompt collapse ───

/**
 * Collapse OpenStarry's multi-message ChatRequest into a single prompt for
 * `claude -p`. The CLI accepts a single positional prompt; chat history is
 * formatted as a transcript (System: / User: / Assistant: prefixes) so the
 * inference call honours conversation context without requiring an
 * interactive REPL session.
 *
 * **README (P4-06 + P4-R2-02)**: `request.systemPrompt` is embedded into the
 * single user-prompt channel by design (CLI exposes one positional prompt
 * argument). Role-prefix injection vector exists if a hostile assistant
 * message contains a literal `\n\nUser: ...` sentinel — caller is trusted
 * to pass app-supplied messages only. See README.md "Prompt Channel +
 * Role-Prefix Injection" section.
 */
export function collapseToPrompt(messages: readonly Message[], systemPrompt?: string): string {
  const lines: string[] = [];
  if (systemPrompt) lines.push(`System: ${systemPrompt}`);
  for (const m of messages) {
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((seg) => (typeof seg === "string" ? seg : (seg as { text?: string }).text ?? "")).join("")
        : "";
    lines.push(`${role}: ${content}`);
  }
  lines.push("Assistant:");
  return lines.join("\n\n");
}

// ─── Disallowed tools list (5-point isolation guarantee #3) ───

const DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "WebSearch",
  "WebFetch",
  "Grep",
  "Glob",
  "NotebookEdit",
].join(",");

// ─── Cycle 03-25 M3 P1-07: Claude CLI major-version pin (defense-in-depth) ───

/**
 * Claude CLI major versions whose tool-set has been security-audited against
 * the 9-tool `DISALLOWED_TOOLS` list above. When the live binary reports a
 * major version outside this set, the adapter warn-logs a re-audit-required
 * event and continues (operator-aware; not a hard block). Per Master
 * directive 2026-05-07 cycle 03-25 M3 P1-07 fix.
 */
export const AUDITED_CLI_MAJORS: readonly string[] = ["1", "2"];

/** Parse `claude --version` stdout. Returns major or null on parse failure. */
export function parseClaudeMajorVersion(versionOutput: string): string | null {
  // Real CLI emits e.g. "1.0.65 (Claude Code)" — pluck leading semver.
  const m = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m[1] : null;
}

// ─── Cycle 03-25 M3 P2-03: subprocess env allowlist ───

/**
 * Allowlist of env-var names forwarded to the `claude` subprocess. ANY env
 * var outside this list is dropped (so agent-side application secrets that
 * happen to live in `process.env` cannot leak to the subprocess).
 *
 * Rationale per O3 §3 P2 + cycle 03-25 M3 R1-03 fix:
 *   - HOME / USERPROFILE — needed for OAuth `~/.claude/` discovery
 *   - PATH — needed by the binary for shelling out (npm-installed runtime)
 *   - LANG / LC_ALL / LC_CTYPE — locale (deterministic stderr message format)
 *   - TERM — TTY (CLI may render differently if absent)
 *   - TMPDIR / TEMP / TMP — tmpdir resolution
 *   - XDG_CONFIG_HOME / XDG_CACHE_HOME / XDG_DATA_HOME — XDG dirs
 *   - USER / USERNAME / LOGNAME — process identity for log lines
 *   - SystemRoot / SystemDrive / windir / ComSpec — Windows essentials
 *   - APPDATA / LOCALAPPDATA / ProgramData / ProgramFiles / "ProgramFiles(x86)" — Windows config
 *   - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN — explicit pass-through if set
 *     (OAuth path doesn't need these; allowlist preserves API-key fallback)
 *   - SHELL — `claude` may shell out (preserved for parity)
 *   - PWD — current working dir (set explicitly via spawn `cwd`)
 */
export const ALLOWED_ENV_KEYS: readonly string[] = [
  // POSIX / cross-platform
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  // XDG dirs
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // Anthropic auth (preserve fallback path; OAuth doesn't require these)
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // Windows
  "USERNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
];

/** Build an env object containing only the allowlisted keys present on input. */
export function buildAllowlistedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ALLOWED_ENV_KEYS) {
    const v = source[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ─── Cycle 03-25 M3 P2-01: PATH-shadowing-safe binary resolution ───

/**
 * Cycle 03-27 hygiene fix F-CY25-§4-R2-05 (LOW): module-level memoization of
 * resolved binary paths. Without this, every adapter init under parallel
 * subagent dispatch repeats the PATH walk — fan-out N-fold where N = parallel
 * adapter inits. Memoization is keyed by the raw input `cliPath`; multiple
 * adapters using the same configured path share a single resolution and the
 * resolution is captured at first invocation (per Master O3 §3 R2-05 fix
 * suggestion). Test-only reset via `__resetResolveClaudeBinaryCacheForTests`.
 */
const _resolveBinaryCache = new Map<string, string | null>();

/** Test-only: clear the resolution memoization. */
export function __resetResolveClaudeBinaryCacheForTests(): void {
  _resolveBinaryCache.clear();
}

/**
 * Resolve `cliPath` to an absolute filesystem path. If `cliPath` is already
 * absolute, returns it as-is (after `realpathSync` to follow symlinks).
 * Otherwise walks `process.env.PATH` and returns the first matching entry.
 * Returns null when the binary cannot be located (caller falls back to the
 * raw `cliPath` so the existing "binary not found" `error` event still fires
 * at first chat() spawn).
 *
 * Per cycle 03-25 M3 P2-01 fix: subprocess MUST receive an absolute path so
 * PATH-shadowing (e.g., a malicious `claude` earlier in PATH) cannot reroute.
 *
 * **Cycle 03-27 hygiene F-CY25-§4-R2-05 (LOW)**: result is memoized at module
 * scope so concurrent adapter inits sharing the same `cliPath` resolve once.
 * This caps PATH-shadow re-evaluation fan-out at 1 per unique input string.
 */
export function resolveClaudeBinary(cliPath: string): string | null {
  const cached = _resolveBinaryCache.get(cliPath);
  if (cached !== undefined) return cached;
  const resolved = _resolveClaudeBinaryImpl(cliPath);
  _resolveBinaryCache.set(cliPath, resolved);
  return resolved;
}

function _resolveClaudeBinaryImpl(cliPath: string): string | null {
  if (isAbsolute(cliPath)) {
    try {
      return realpathSync(cliPath);
    } catch {
      return existsSync(cliPath) ? cliPath : null;
    }
  }

  const pathEnv = process.env.PATH ?? "";
  if (pathEnv.length === 0) return null;

  const exts = process.platform === "win32"
    ? ((process.env.PATHEXT ?? ".CMD;.EXE;.BAT").split(";").filter((e) => e.length > 0))
    : [""];

  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, cliPath + ext);
      try {
        const s = statSync(candidate);
        if (!s.isFile()) continue;
        try {
          return realpathSync(candidate);
        } catch {
          return candidate;
        }
      } catch {
        // not present at this PATH entry; continue
      }
    }
  }
  return null;
}

// ─── Subprocess invocation ───

/**
 * Minimal system-prompt that overrides any user-level CLAUDE.md context
 * the subprocess might otherwise load (guarantee #2 v4 replacement for `--bare`).
 */
const ISOLATION_SYSTEM_PROMPT =
  "You are an inference engine. Do not invoke tools. Reply concisely.";

/**
 * Cycle 03-27 hygiene fix F-CY25-§4-R1-04 (LOW): explicit subprocess cwd =
 * OS tmpdir, codified as an exported getter so unit tests can pin the
 * invariant. Implicit cwd inheritance would let `claude` discover
 * project-scoped `.claude/settings.local.json` via ancestor walk; setting
 * cwd to tmpdir() guarantees no `.claude/` chain exists above the subprocess.
 * Pairs with the `--strict-mcp-config` + `--system-prompt` + `--disable-slash-commands`
 * isolation triple as a fourth, fs-level defense (per O3 §2.5).
 */
export function getSubprocessCwd(): string {
  return tmpdir();
}

let _emptyMcpConfigPath: string | null = null;
let _exitCleanupRegistered = false;

/**
 * Lazily create (once per process) an empty MCP config file at OS tmpdir
 * containing `{"mcpServers": {}}`. Used with `--strict-mcp-config --mcp-config <path>`
 * to skip MCP discovery (HOTFIX v4 guarantee #2 replacement for `--bare`).
 *
 * **Per guarantee #5**: writes to OS tmpdir (NOT user/project settings); file is
 * per-PID isolated (`...mcp-empty-${pid}.json`) so parallel processes do not
 * collide. The plugin never modifies `~/.claude/*` or `.claude/*`.
 *
 * **README (P4-R2-06)**: file is `chmod 0o600` so only the owning user can
 * read/write — defends against same-host info leak via the empty config.
 *
 * **Cycle 03-27 hygiene F-CY25-§4-R1-05 (LOW)**: on first creation we register
 * a `process.on("exit")` handler that unlinks the file; previously stale
 * per-PID files accumulated in tmpdir across process generations. The
 * registration is idempotent (`_exitCleanupRegistered` guard) so multiple
 * adapter instances within the same process do not pile up listeners.
 */
export function ensureEmptyMcpConfigPath(): string {
  if (_emptyMcpConfigPath !== null) return _emptyMcpConfigPath;
  const path = join(tmpdir(), `openstarry-claude-cli-mcp-empty-${process.pid}.json`);
  writeFileSync(path, '{"mcpServers": {}}', { mode: 0o600 });
  _emptyMcpConfigPath = path;
  if (!_exitCleanupRegistered) {
    process.on("exit", cleanupEmptyMcpConfigPath);
    _exitCleanupRegistered = true;
  }
  return path;
}

/**
 * Cycle 03-27 hygiene F-CY25-§4-R1-05 + F-CY25-§4-R2-03 (both LOW): unlink
 * the per-PID empty MCP config file (if created) and reset the cached path.
 * Safe to call multiple times — `existsSync` guards the unlink, `unlinkSync`
 * errors are swallowed (best-effort cleanup; not a hard contract).
 *
 * Invoked by `process.on("exit")` (one-shot at process termination) and by
 * the plugin `dispose()` hook (one-shot when the runtime unloads the plugin).
 */
export function cleanupEmptyMcpConfigPath(): void {
  if (_emptyMcpConfigPath === null) return;
  try {
    if (existsSync(_emptyMcpConfigPath)) unlinkSync(_emptyMcpConfigPath);
  } catch {
    // best-effort hygiene; ignore failures (file may already be gone or
    // tmpdir may be read-only mid-shutdown).
  }
  _emptyMcpConfigPath = null;
}

/** Test-only: reset cached path so a fresh write happens on next call. */
export function __resetEmptyMcpConfigPathForTests(): void {
  _emptyMcpConfigPath = null;
}

/**
 * Build the argv array enforcing the 5-point process-level isolation
 * guarantees. Pure function — extracted for unit testing without spawning.
 *
 * **HOTFIX v4 cycle 03-21 (v0.55.4-alpha)**: `--bare` was removed because it
 * is incompatible with OAuth (`--bare` requires `ANTHROPIC_API_KEY`; Master uses
 * Pro/Max OAuth via `claude auth login`). Equivalent isolation is now
 * achieved through three replacement flags:
 *   - `--system-prompt <minimal>` overrides any CLAUDE.md context inheritance
 *   - `--strict-mcp-config --mcp-config <empty.json>` skips MCP discovery
 *   - `--disable-slash-commands` skips skills
 *
 * @param args.mcpEmptyConfigPath absolute path to a JSON file containing
 *   `{"mcpServers": {}}`; consumer creates this once per process via
 *   `ensureEmptyMcpConfigPath()` (lazy lifecycle managed by streamClaudeCli).
 */
export function buildArgv(args: {
  readonly prompt: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly effort?: ClaudeCliConfig["effort"];
  readonly mcpEmptyConfigPath: string;
}): string[] {
  const argv = [
    "-p", args.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // HOTFIX v4 guarantee #2 replacement (OAuth-compatible isolation triple):
    "--system-prompt", ISOLATION_SYSTEM_PROMPT,           // override CLAUDE.md context
    "--strict-mcp-config", "--mcp-config", args.mcpEmptyConfigPath, // skip MCP discovery
    "--disable-slash-commands",                            // skip skills
    "--disallowedTools", DISALLOWED_TOOLS,                 // guarantee #3: disable built-in tools
    "--max-turns", String(args.maxTurns),                  // pure inference; no agentic loop
    "--no-session-persistence",                            // guarantee #4: no disk session log
    "--model", args.model,
  ];
  if (args.effort !== undefined) {
    argv.push("--effort", args.effort);
  }
  return argv;
}

// ─── Cycle 03-27 hygiene F-CY25-§4-R1-02: stderr disclosure redaction ───

/** Patterns redacted before stderr is forwarded into upstream `Error.message`. */
const STDERR_REDACT_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-[A-Za-z0-9_\-]{8,}/g,                              // Anthropic-style keys
  /Bearer\s+[A-Za-z0-9._\-]+/gi,                         // OAuth bearer tokens
  /(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=\S+/g,       // env-style key=value
];

/** Cycle 03-27 hygiene F-CY25-§4-R1-02 (LOW): tighter cap on stderr snippet. */
export const STDERR_REDACT_MAX_LEN = 200;

/**
 * Cycle 03-27 hygiene fix F-CY25-§4-R1-02 (LOW): redact known-sensitive
 * substrings (API keys, OAuth bearer tokens, env-style auth assignments)
 * from the stderr buffer before forwarding into `Error.message`. Previously
 * the snippet was truncated to 500 chars verbatim; under failure modes
 * (e.g., auth error) it could surface partial OAuth state into upstream
 * StructuredError logs that persist longer than the inference call.
 *
 * Truncation cap also tightened from 500 → 200 chars (per O3 §2.3
 * defense-in-depth recommendation).
 */
export function redactStderrForError(snippet: string): string {
  let out = snippet;
  for (const re of STDERR_REDACT_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  out = out.trim();
  if (out.length > STDERR_REDACT_MAX_LEN) {
    out = out.slice(0, STDERR_REDACT_MAX_LEN) + "…";
  }
  return out;
}

// ─── Stream-JSON parsing ───

interface ClaudeStreamLine {
  readonly type?: string;
  readonly subtype?: string;
  readonly text?: string;
  /** Stream event envelope (real Claude CLI shape per Hermes SKILL.md line 149-163). */
  readonly event?: { delta?: { type?: string; text?: string } };
  /** Final result line: `result` is the full TEXT STRING (already streamed via deltas). */
  readonly result?: string;
  readonly is_error?: boolean;
  readonly error?: string;
  /** Defensive: legacy assistant-content shape some CLI versions emit mid-stream. */
  readonly content?: Array<{ type?: string; text?: string }>;
  /** Claude CLI v2.1.140+ assistant shape — content array nested at message.content. */
  readonly message?: { content?: Array<{ type?: string; text?: string }> };
}

/** Known silently-ignored line types — anything else is "unknown" per P1-08.
 * `rate_limit_event` added FIX-2026-06-11: CLI >=2.1.170 emits it on every
 * call; informational only (rate-limit telemetry), safe to ignore. */
const KNOWN_SILENT_TYPES: ReadonlySet<string> = new Set(["system", "api_retry", "rate_limit_event"]);

/** Per-stream dedup state for mapStreamEvent (FIX-2026-06-11 double-render). */
export interface StreamMapState {
  /** True once any stream_event text_delta has been emitted for this stream. */
  sawStreamDelta: boolean;
}

/**
 * Map a single Claude CLI stream-json line to an OpenStarry ProviderStreamEvent.
 * Returns null when the line should be silently ignored (status/system events).
 *
 * Pure function — extracted for unit testing without spawning.
 *
 * **HOTFIX v5 cycle 03-21 (v0.55.5-alpha)**: schema corrected against the real
 * Claude CLI stream-json output (per Hermes SKILL.md line 149-163; cycle 03-21
 * 7th BLOCKER root cause):
 *
 *   - `stream_event` carries text under `event.delta.{type, text}` (v4 read
 *     the wrong path `delta.text`, so every text-delta yielded null).
 *   - `result` line shape: `{type: "result", subtype: "success"|"error_*",
 *     is_error: bool, result: "<text string>", session_id, num_turns, ...}`.
 *
 * **Cycle 03-25 M3 P1-08 fix (v0.57.2-alpha)**: unknown line types are no
 * longer silently dropped. The optional `onUnknown(lineType)` callback is
 * invoked so the streamer can warn-log; mapping still returns null so the
 * stream stays alive (defensive — don't break inference for novel CLI
 * versions). Pre-existing call sites without the callback continue to work.
 */
export function mapStreamEvent(
  line: ClaudeStreamLine,
  onUnknown?: (lineType: string) => void,
  state?: StreamMapState,
): ProviderStreamEvent | null {
  if (line.type === "stream_event") {
    const delta = line.event?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      if (state) state.sawStreamDelta = true;
      return { type: "text_delta", text: delta.text };
    }
    // ignore non-text deltas (tool_use is disabled by --disallowedTools anyway)
    return null;
  }
  if (line.type === "assistant") {
    // FIX-2026-06-11 double-render: CLI >=2.1.14x emits BOTH incremental
    // stream_event deltas AND a final full-message `assistant` line for the
    // same turn. If deltas were already streamed, the assistant line is a
    // duplicate of text the UI has already rendered — drop it. Legacy CLIs
    // emit ONLY assistant lines; those still pass (sawStreamDelta stays false).
    if (state?.sawStreamDelta) return null;
    // Two shapes observed across Claude CLI versions:
    //   - legacy: line.content = [{type:"text", text:"..."}, ...]
    //   - v2.1.140+: line.message.content = [{type:"text", text:"..."}, ...]
    // (FIX-cy31-A1-1-T4-MAPSTREAM sub-task A — DT-42-B cycle 03-43.)
    const parts =
      (Array.isArray(line.content) ? line.content : undefined) ??
      (Array.isArray(line.message?.content) ? line.message?.content : undefined);
    if (!parts) return null;
    const text = parts
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    if (text.length > 0) return { type: "text_delta", text };
    return null;
  }
  if (line.type === "result") {
    if (line.subtype === "success" && line.is_error === false) {
      // result text already streamed via stream_event deltas; just signal finish.
      return { type: "finish", stopReason: "end_turn" };
    }
    const reason = line.subtype ?? line.error ?? "claude-cli reported failure";
    return { type: "error", error: new Error(`Claude CLI error: ${reason}`) };
  }
  if (line.type === "error") {
    return { type: "error", error: new Error(line.error ?? "claude-cli error event") };
  }
  // Cycle 03-25 M3 P1-08: surface unknown line types via callback (warn-log
  // upstream); still return null so the stream stays alive for novel CLI
  // versions. Known silent types (system / api_retry) bypass the callback.
  if (typeof line.type === "string" && !KNOWN_SILENT_TYPES.has(line.type)) {
    onUnknown?.(line.type);
  }
  return null;
}

// ─── Subprocess streaming ───

async function* streamClaudeCli(args: {
  prompt: string;
  model: string;
  maxTurns: number;
  effort?: ClaudeCliConfig["effort"];
  timeout: number;
  cliPath: string;
  logger: ReturnType<typeof createLogger>;
}): AsyncGenerator<ProviderStreamEvent> {
  const argv = buildArgv({
    prompt: args.prompt,
    model: args.model,
    maxTurns: args.maxTurns,
    effort: args.effort,
    mcpEmptyConfigPath: ensureEmptyMcpConfigPath(),
  });

  let proc: ChildProcessWithoutNullStreams;
  try {
    // 5-point isolation guarantee #1: fresh subprocess per call.
    // Cycle 03-25 M3 P2-03 fix: env allowlist instead of full process.env.
    // Cycle 03-25 M3 P2-01 fix: cliPath is resolved absolute (PATH-shadow safe).
    proc = spawn(args.cliPath, argv, {
      env: buildAllowlistedEnv(process.env),
      cwd: getSubprocessCwd(),                       // Cycle 03-27 F-CY25-§4-R1-04: explicit cwd=tmpdir invariant
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    yield {
      type: "error",
      error: new Error(
        `Claude CLI not found or failed to spawn (${(err as Error).message}). ` +
        `Run: npm install -g @anthropic-ai/claude-code`,
      ),
    };
    return;
  }

  // Close stdin immediately (we passed prompt via -p; subprocess does not need stdin).
  proc.stdin.end();

  const timeoutHandle = setTimeout(() => {
    args.logger.warn(`claude-cli subprocess timeout after ${args.timeout}ms; killing`);
    proc.kill("SIGTERM");
  }, args.timeout);

  let stderrBuffer = "";
  proc.stderr.on("data", (chunk: Buffer) => { stderrBuffer += chunk.toString(); });

  // Buffered NDJSON parsing on stdout.
  let stdoutBuffer = "";
  let yieldedFinish = false;

  type Pending = { line: string };
  const pendingLines: Pending[] = [];
  let stdoutClosed = false;
  let stdoutResolver: (() => void) | null = null;

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    let nl: number;
    while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line.length > 0) pendingLines.push({ line });
    }
    if (stdoutResolver) { stdoutResolver(); stdoutResolver = null; }
  });

  let exitCode: number | null = null;
  let exitError: Error | null = null;
  proc.on("close", (code) => {
    stdoutClosed = true;
    exitCode = code;
    if (stdoutBuffer.trim().length > 0) {
      pendingLines.push({ line: stdoutBuffer.trim() });
      stdoutBuffer = "";
    }
    if (stdoutResolver) { stdoutResolver(); stdoutResolver = null; }
  });
  proc.on("error", (err) => {
    stdoutClosed = true;
    exitError = err;
    if (stdoutResolver) { stdoutResolver(); stdoutResolver = null; }
  });

  // Cycle 03-25 M3 P1-08 onUnknown callback — surface novel line types so
  // future CLI changes are observable instead of silently dropped.
  const onUnknown = (lineType: string): void => {
    args.logger.warn(`claude-cli stream emitted unknown line type "${lineType}" — defensive skip; re-audit may be required`);
  };

  // FIX-2026-06-11: per-stream dedup state — suppresses the duplicate
  // full-message `assistant` line when text was already streamed via deltas.
  const streamState: StreamMapState = { sawStreamDelta: false };

  try {
    while (true) {
      while (pendingLines.length > 0) {
        const { line } = pendingLines.shift()!;
        let parsed: ClaudeStreamLine;
        try {
          parsed = JSON.parse(line) as ClaudeStreamLine;
        } catch {
          args.logger.debug(`claude-cli non-JSON line skipped: ${line.slice(0, 80)}`);
          continue;
        }
        const evt = mapStreamEvent(parsed, onUnknown, streamState);
        if (evt) {
          if (evt.type === "finish") yieldedFinish = true;
          yield evt;
        }
      }
      if (stdoutClosed) break;
      await new Promise<void>((resolve) => { stdoutResolver = resolve; });
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (!proc.killed) proc.kill("SIGTERM");
  }

  if (exitError) {
    yield { type: "error", error: exitError };
    return;
  }
  if (exitCode !== null && exitCode !== 0 && !yieldedFinish) {
    // Cycle 03-27 F-CY25-§4-R1-02: redact + tighter truncation cap before
    // surfacing into Error.message (upstream StructuredError logs persist).
    const stderrSnippet = redactStderrForError(stderrBuffer);
    yield {
      type: "error",
      error: new Error(
        `claude-cli exited with code ${exitCode}` +
        (stderrSnippet ? ` — stderr: ${stderrSnippet}` : ""),
      ),
    };
    return;
  }
  if (!yieldedFinish && exitCode === 0) {
    // Subprocess succeeded but emitted no result event — defensive close.
    yield { type: "finish", stopReason: "end_turn" };
  }
}

// ─── Provider adapter ───

function createClaudeCliAdapter(cfg: ClaudeCliConfig): IProvider {
  const logger = createLogger("claude-cli");
  const defaultModel = cfg.model ?? "sonnet";
  const maxTurns = cfg.maxTurns ?? 1;
  const timeout = cfg.timeout ?? 60_000;
  const rawCliPath = cfg.cliPath ?? "claude";

  // Cycle 03-25 M3 P2-01 fix: resolve absolute path at adapter init (best
  // effort). On failure, fall back to raw path so the existing
  // "binary not found" error path at first spawn still fires; init never
  // throws (test scenarios don't always have `claude` installed).
  const resolved = resolveClaudeBinary(rawCliPath);
  if (resolved !== null) {
    logger.debug(`resolved claude binary: ${resolved}`);
  } else {
    logger.warn(`could not resolve "${rawCliPath}" to absolute path; spawn will rely on system PATH (PATH-shadowing risk — install claude or set absolute cliPath)`);
  }
  const cliPath = resolved ?? rawCliPath;

  // Cycle 03-25 M3 P2-04 fix: forward-watch warn for multi-turn.
  if (maxTurns > 1) {
    logger.warn(`maxTurns=${maxTurns} > 1: subprocess agentic loop runs internally; OpenStarry agent loop cannot inspect intermediate state. Re-audit is required for any consumer relying on per-turn observability.`);
  }

  return {
    skandha: "samjna" as const,
    id: "claude-cli",
    name: "Claude (CLI subprocess)",
    models: MODELS,
    loginHint: { usage: "", description: "Claude CLI (already authenticated via `claude auth login`)" },

    isConfigured(): boolean {
      // The plugin assumes the CLI is installed + authenticated externally.
      // A live binary check would require spawning at boot; defer to first call.
      return true;
    },

    async *chat(request: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const prompt = collapseToPrompt(request.messages, request.systemPrompt);
      const model = request.model || defaultModel;
      yield* streamClaudeCli({
        prompt,
        model,
        maxTurns,
        effort: cfg.effort,
        timeout,
        cliPath,
        logger,
      });
    },
  };
}

// ─── Plugin export ───

export function createClaudeCliPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/provider-claude-cli",
      version: "0.1.0-alpha",
      description: "Claude CLI subprocess provider (text-only inference; no function-calling)",
      skandha: "samjna" as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const cfg = (ctx.config ?? {}) as ClaudeCliConfig;
      const provider = createClaudeCliAdapter(cfg);
      return {
        providers: [provider],
        dispose() {
          // Cycle 03-27 F-CY25-§4-R2-03 + F-CY25-§4-R1-05 (both LOW): on
          // runtime unload, unlink the per-PID empty MCP config file and
          // reset the cached path so a fresh write happens on next load.
          // Each chat() call still spawns + closes its own subprocess; the
          // empty MCP config is the only long-lived artefact this plugin
          // owns.
          cleanupEmptyMcpConfigPath();
        },
      };
    },
  };
}

export default createClaudeCliPlugin;
