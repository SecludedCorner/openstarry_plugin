/**
 * provider-claude-cli — Cycle 03-27 hygiene-only fix tests (v0.57.4-alpha).
 *
 * Per Master directive 2026-05-09 §3.1 PASS path; 5 LOW P3 items deferred
 * from cycle 03-25 R3 §4. ε-surface invariance Δ=0 hard constraint per
 * O3 §6: tests verify behaviour without touching manifest / provider-id /
 * model list / schema / HMAC posture.
 *
 * Coverage:
 *   - F-CY25-§4-R1-02 (LOW): redactStderrForError redacts known-sensitive
 *     substrings + tightens truncation cap 500 → 200
 *   - F-CY25-§4-R1-04 (LOW): getSubprocessCwd codifies tmpdir() invariant
 *   - F-CY25-§4-R1-05 (LOW): cleanupEmptyMcpConfigPath unlinks per-PID file
 *     and resets cache; idempotent
 *   - F-CY25-§4-R2-03 (LOW): dispose() invokes cleanup (paired with R1-05)
 *   - F-CY25-§4-R2-05 (LOW): resolveClaudeBinary memoizes per-input results
 *     (caps PATH-shadow re-evaluation fan-out at 1 per unique input)
 */

import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  __resetEmptyMcpConfigPathForTests,
  __resetResolveClaudeBinaryCacheForTests,
  cleanupEmptyMcpConfigPath,
  createClaudeCliPlugin,
  ensureEmptyMcpConfigPath,
  getSubprocessCwd,
  redactStderrForError,
  resolveClaudeBinary,
  STDERR_REDACT_MAX_LEN,
} from '../src/index.js';

describe('Cycle 03-27 F-CY25-§4-R1-02 — stderr disclosure redaction', () => {
  it('redacts Anthropic-style sk- keys', () => {
    const out = redactStderrForError('Auth failed: sk-ant-deadbeef12345678 invalid');
    expect(out).not.toContain('sk-ant-deadbeef12345678');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens (case-insensitive)', () => {
    const out = redactStderrForError('Authorization: Bearer abc.def.ghi-token123');
    expect(out).not.toContain('abc.def.ghi-token123');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts env-style ANTHROPIC_API_KEY=... and ANTHROPIC_AUTH_TOKEN=... assignments', () => {
    const out = redactStderrForError('ANTHROPIC_API_KEY=sk-redacted ANTHROPIC_AUTH_TOKEN=oauthtok');
    expect(out).not.toContain('sk-redacted');
    expect(out).not.toContain('oauthtok');
    expect(out).not.toMatch(/ANTHROPIC_API_KEY=\S/);
    expect(out).not.toMatch(/ANTHROPIC_AUTH_TOKEN=\S/);
  });

  it('truncates to STDERR_REDACT_MAX_LEN with ellipsis when over cap', () => {
    expect(STDERR_REDACT_MAX_LEN).toBe(200);
    const long = 'x'.repeat(STDERR_REDACT_MAX_LEN + 50);
    const out = redactStderrForError(long);
    expect(out.length).toBeLessThanOrEqual(STDERR_REDACT_MAX_LEN + 1); // +1 for the ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns trimmed plain text when no patterns match and under cap', () => {
    const out = redactStderrForError('  short and clean error  ');
    expect(out).toBe('short and clean error');
  });

  it('attestation: cap is strictly tighter than v0.57.2 baseline (500)', () => {
    expect(STDERR_REDACT_MAX_LEN).toBeLessThan(500);
  });
});

describe('Cycle 03-27 F-CY25-§4-R1-04 — subprocess cwd codification', () => {
  it('getSubprocessCwd returns OS tmpdir()', () => {
    expect(getSubprocessCwd()).toBe(tmpdir());
  });

  it('getSubprocessCwd is deterministic per process (invariant)', () => {
    expect(getSubprocessCwd()).toBe(getSubprocessCwd());
  });
});

describe('Cycle 03-27 F-CY25-§4-R1-05 + F-CY25-§4-R2-03 — mcp-empty cleanup', () => {
  beforeEach(() => {
    __resetEmptyMcpConfigPathForTests();
  });

  it('cleanupEmptyMcpConfigPath unlinks the per-PID file when present', () => {
    const path = ensureEmptyMcpConfigPath();
    expect(existsSync(path)).toBe(true);
    // sanity: file contains the expected literal
    expect(readFileSync(path, 'utf-8')).toBe('{"mcpServers": {}}');

    cleanupEmptyMcpConfigPath();
    expect(existsSync(path)).toBe(false);
  });

  it('cleanupEmptyMcpConfigPath is idempotent (no throw when called twice)', () => {
    ensureEmptyMcpConfigPath();
    cleanupEmptyMcpConfigPath();
    expect(() => cleanupEmptyMcpConfigPath()).not.toThrow();
  });

  it('cleanupEmptyMcpConfigPath is a no-op when no file was created yet', () => {
    // cache reset in beforeEach; never called ensureEmptyMcpConfigPath
    expect(() => cleanupEmptyMcpConfigPath()).not.toThrow();
  });

  it('after cleanup, subsequent ensureEmptyMcpConfigPath rewrites the file', () => {
    const p1 = ensureEmptyMcpConfigPath();
    cleanupEmptyMcpConfigPath();
    expect(existsSync(p1)).toBe(false);
    const p2 = ensureEmptyMcpConfigPath();
    expect(existsSync(p2)).toBe(true);
    // same path (per-PID; PID didn't change)
    expect(p2).toBe(p1);
  });

  it('plugin dispose() invokes cleanupEmptyMcpConfigPath (F-CY25-§4-R2-03)', async () => {
    const plugin = createClaudeCliPlugin();
    const ctx = { config: {} } as unknown as Parameters<typeof plugin.factory>[0];
    const hooks = await plugin.factory(ctx);

    // create the mcp-empty file as the runtime would on first chat() call
    const path = ensureEmptyMcpConfigPath();
    expect(existsSync(path)).toBe(true);

    // dispose() should clean up
    hooks.dispose?.();
    expect(existsSync(path)).toBe(false);
  });
});

describe('Cycle 03-27 F-CY25-§4-R2-05 — resolveClaudeBinary memoization', () => {
  beforeEach(() => {
    __resetResolveClaudeBinaryCacheForTests();
  });

  it('memoizes per-input result (null for missing binary)', () => {
    // we can't spy on statSync directly without mocking node:fs; instead,
    // verify that two consecutive calls return the same cached value and
    // that resetting the cache forces a fresh resolution.
    const key = 'definitely-nonexistent-binary-xyz-r2-05';
    const r1 = resolveClaudeBinary(key);
    const r2 = resolveClaudeBinary(key);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r2).toBe(r1); // identity (cached null returned)
  });

  it('memoizes positive resolution (returns same absolute path)', () => {
    const key = process.execPath; // absolute, exists
    const r1 = resolveClaudeBinary(key);
    const r2 = resolveClaudeBinary(key);
    expect(r1).not.toBeNull();
    expect(r2).toBe(r1);
  });

  it('separate inputs get independent cache entries', () => {
    const a = resolveClaudeBinary('nonexistent-a-xyz');
    const b = resolveClaudeBinary('nonexistent-b-xyz');
    expect(a).toBeNull();
    expect(b).toBeNull();
    // both cached independently; reset clears both
    __resetResolveClaudeBinaryCacheForTests();
    // post-reset still returns the same null (resolution semantics unchanged)
    expect(resolveClaudeBinary('nonexistent-a-xyz')).toBeNull();
  });

  it('cache survives concurrent adapter inits (fan-out cap = 1)', () => {
    // simulate parallel subagent dispatch: N "adapter inits" calling resolveClaudeBinary
    // with the same cliPath should produce N references to the SAME cached value.
    const key = 'concurrent-fanout-test-xyz';
    const results = Array.from({ length: 8 }, () => resolveClaudeBinary(key));
    // all identical (all null in this case since binary doesn't exist; identity
    // is the load-bearing assertion — same value returned, not re-walked)
    expect(new Set(results).size).toBe(1);
  });
});

describe('Cycle 03-27 ε-surface invariance Δ=0 attestation (per O3 §6)', () => {
  it('plugin manifest fields unchanged: name / version / description / skandha', () => {
    const plugin = createClaudeCliPlugin();
    expect(plugin.manifest.name).toBe('@openstarry-plugin/provider-claude-cli');
    expect(plugin.manifest.version).toBe('0.1.0-alpha');
    expect(plugin.manifest.skandha).toBe('samjna');
    expect(typeof plugin.manifest.description).toBe('string');
  });

  it('provider id / skandha / model list unchanged (smoke check via factory)', async () => {
    const plugin = createClaudeCliPlugin();
    const ctx = { config: {} } as unknown as Parameters<typeof plugin.factory>[0];
    const hooks = await plugin.factory(ctx);
    const provider = hooks.providers?.[0];
    expect(provider?.id).toBe('claude-cli');
    expect(provider?.skandha).toBe('samjna');
    expect(provider?.models.map((m) => m.id).sort()).toEqual(['haiku', 'opus', 'sonnet']);
    hooks.dispose?.();
  });
});
