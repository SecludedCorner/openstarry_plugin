/**
 * provider-claude-cli — pure-function unit tests.
 *
 * Tests the 5-point process-level isolation guarantees at the argv level
 * (no subprocess spawn) + stream-event mapping correctness.
 *
 * **HOTFIX v4 cycle 03-21 (v0.55.4-alpha)**: `--bare` was removed (OAuth
 * incompatible — required `ANTHROPIC_API_KEY`). Equivalent isolation now
 * achieved through three replacement flags:
 *   - `--system-prompt <minimal>` (overrides CLAUDE.md context)
 *   - `--strict-mcp-config --mcp-config <empty.json>` (skips MCP discovery)
 *   - `--disable-slash-commands` (skips skills)
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderStreamEvent } from '@openstarry/sdk';
import {
  __resetEmptyMcpConfigPathForTests,
  buildArgv,
  ensureEmptyMcpConfigPath,
  mapStreamEvent,
} from '../src/index.js';

const MCP = '/tmp/openstarry-test-mcp.json';
const baseArgs = { prompt: 'hi', model: 'sonnet', maxTurns: 1, mcpEmptyConfigPath: MCP } as const;

describe('provider-claude-cli — buildArgv (5-point isolation guarantees, HOTFIX v4)', () => {
  it('does NOT emit --bare (HOTFIX v4: OAuth incompatibility)', () => {
    const argv = buildArgv(baseArgs);
    expect(argv).not.toContain('--bare');
  });

  it('emits --system-prompt with the minimal isolation prompt (guarantee #2 v4 part 1: override CLAUDE.md)', () => {
    const argv = buildArgv(baseArgs);
    const idx = argv.indexOf('--system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    const value = argv[idx + 1];
    expect(value).toContain('inference engine');
    expect(value).toContain('Do not invoke tools');
  });

  it('emits --strict-mcp-config + --mcp-config <empty.json path> (guarantee #2 v4 part 2: skip MCP discovery)', () => {
    const argv = buildArgv(baseArgs);
    expect(argv).toContain('--strict-mcp-config');
    const idx = argv.indexOf('--mcp-config');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe(MCP);
  });

  it('emits --disable-slash-commands (guarantee #2 v4 part 3: skip skills)', () => {
    const argv = buildArgv(baseArgs);
    expect(argv).toContain('--disable-slash-commands');
  });

  it('emits --disallowedTools with all 9 built-in tools (guarantee #3)', () => {
    const argv = buildArgv(baseArgs);
    const idx = argv.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const value = argv[idx + 1];
    for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Grep', 'Glob', 'NotebookEdit']) {
      expect(value).toContain(tool);
    }
  });

  it('emits --no-session-persistence (guarantee #4: no disk session log)', () => {
    const argv = buildArgv(baseArgs);
    expect(argv).toContain('--no-session-persistence');
  });

  it('emits --max-turns capping the agentic loop', () => {
    const argv = buildArgv(baseArgs);
    const idx = argv.indexOf('--max-turns');
    expect(argv[idx + 1]).toBe('1');
  });

  it('emits --output-format stream-json + --include-partial-messages', () => {
    const argv = buildArgv(baseArgs);
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--include-partial-messages');
  });

  it('emits the prompt via -p (positional inline)', () => {
    const argv = buildArgv({ ...baseArgs, prompt: 'analyze this' });
    const pIdx = argv.indexOf('-p');
    expect(pIdx).toBe(0);
    expect(argv[pIdx + 1]).toBe('analyze this');
  });

  it('emits --model with the requested alias', () => {
    const argv = buildArgv({ ...baseArgs, model: 'opus' });
    const idx = argv.indexOf('--model');
    expect(argv[idx + 1]).toBe('opus');
  });

  it('emits --effort only when provided', () => {
    const without = buildArgv(baseArgs);
    expect(without.includes('--effort')).toBe(false);
    const withEffort = buildArgv({ ...baseArgs, effort: 'high' });
    const idx = withEffort.indexOf('--effort');
    expect(withEffort[idx + 1]).toBe('high');
  });
});

describe('provider-claude-cli — ensureEmptyMcpConfigPath (guarantee #5: never touch user/project settings)', () => {
  let createdPath: string | null = null;

  afterEach(() => {
    if (createdPath !== null && existsSync(createdPath)) {
      try { unlinkSync(createdPath); } catch { /* best effort */ }
    }
    createdPath = null;
    __resetEmptyMcpConfigPathForTests();
  });

  it('writes the empty mcp config under OS tmpdir (NOT under ~/.claude or .claude)', () => {
    const path = ensureEmptyMcpConfigPath();
    createdPath = path;
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path).not.toContain('.claude');
  });

  it('writes exactly {"mcpServers": {}} (so --strict-mcp-config sees no servers)', () => {
    const path = ensureEmptyMcpConfigPath();
    createdPath = path;
    const content = readFileSync(path, 'utf-8');
    expect(JSON.parse(content)).toEqual({ mcpServers: {} });
  });

  it('is idempotent — repeated calls return the same path without re-writing', () => {
    const first = ensureEmptyMcpConfigPath();
    createdPath = first;
    const mtimeBefore = statSync(first).mtimeMs;
    const second = ensureEmptyMcpConfigPath();
    expect(second).toBe(first);
    const mtimeAfter = statSync(second).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('embeds the PID in the filename (parallel-process safe per guarantee #5)', () => {
    const path = ensureEmptyMcpConfigPath();
    createdPath = path;
    expect(path).toContain(String(process.pid));
  });
});

describe('provider-claude-cli — mapStreamEvent (HOTFIX v5: real Claude CLI stream-json schema)', () => {
  it('maps stream_event event.delta.{type:text_delta, text} → text_delta', () => {
    const evt = mapStreamEvent({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'hello' } },
    });
    expect(evt).toEqual({ type: 'text_delta', text: 'hello' });
  });

  it('ignores stream_event with empty/missing delta text', () => {
    expect(mapStreamEvent({ type: 'stream_event' })).toBeNull();
    expect(mapStreamEvent({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: '' } },
    })).toBeNull();
  });

  it('ignores stream_event whose delta type is not text_delta (tool_use / etc)', () => {
    expect(mapStreamEvent({
      type: 'stream_event',
      event: { delta: { type: 'tool_use', text: 'ignored' } },
    })).toBeNull();
  });

  it('aggregates assistant content[].text → text_delta (defensive legacy shape)', () => {
    const evt = mapStreamEvent({
      type: 'assistant',
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
    });
    expect(evt).toEqual({ type: 'text_delta', text: 'hello world' });
  });

  it('result subtype=success + is_error=false → finish stopReason=end_turn', () => {
    const evt = mapStreamEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello, world!',
    });
    expect(evt).toEqual({ type: 'finish', stopReason: 'end_turn' });
  });

  it('result subtype=error_max_turns + is_error=true → error event citing subtype', () => {
    const evt = mapStreamEvent({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
    });
    expect(evt?.type).toBe('error');
    if (evt?.type === 'error') expect(evt.error.message).toContain('error_max_turns');
  });

  it('result without success subtype → error event', () => {
    const evt = mapStreamEvent({ type: 'result' });
    expect(evt?.type).toBe('error');
  });

  it('explicit type=error → error event', () => {
    const evt = mapStreamEvent({ type: 'error', error: 'boom' });
    expect(evt?.type).toBe('error');
    if (evt?.type === 'error') expect(evt.error.message).toBe('boom');
  });

  it('unrecognised types (system / api_retry) silently ignored', () => {
    expect(mapStreamEvent({ type: 'system' })).toBeNull();
    expect(mapStreamEvent({ type: 'api_retry' })).toBeNull();
    expect(mapStreamEvent({ type: undefined as unknown as string })).toBeNull();
  });
});

describe('provider-claude-cli — mapStreamEvent fixture replay (real CLI ndjson)', () => {
  const SUCCESS_FIXTURE = readFileSync(
    new URL('./fixtures/stream-json-success.txt', import.meta.url),
    'utf-8',
  );
  const ERROR_FIXTURE = readFileSync(
    new URL('./fixtures/stream-json-error.txt', import.meta.url),
    'utf-8',
  );

  function replay(fixture: string) {
    const events: ProviderStreamEvent[] = [];
    for (const line of fixture.split('\n').filter((l) => l.trim().length > 0)) {
      const parsed = JSON.parse(line);
      const evt = mapStreamEvent(parsed);
      if (evt !== null) events.push(evt);
    }
    return events;
  }

  it('success fixture: 4 text_delta + 1 finish (system + api_retry skipped)', () => {
    const events = replay(SUCCESS_FIXTURE);
    expect(events).toHaveLength(5);
    expect(events.slice(0, 4)).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ', ' },
      { type: 'text_delta', text: 'world' },
      { type: 'text_delta', text: '!' },
    ]);
    expect(events[4]).toEqual({ type: 'finish', stopReason: 'end_turn' });
    const reconstructed = events
      .filter((e): e is ProviderStreamEvent & { type: 'text_delta' } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(reconstructed).toBe('Hello, world!');
  });

  it('error fixture: 1 text_delta + 1 error citing error_max_turns', () => {
    const events = replay(ERROR_FIXTURE);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'Working' });
    expect(events[1].type).toBe('error');
    if (events[1].type === 'error') {
      expect(events[1].error.message).toContain('error_max_turns');
    }
  });
});
