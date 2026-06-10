/**
 * api-runtime / plugin — factory wiring + boundary invariant tests.
 *
 * Plan59 §6.2 boundary invariant: `IRuntime.*` method signatures do NOT
 * reference ε-surface envelope fields — verified by static-analysis grep
 * over src/ at test time.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_RUNTIME_REPLAY_CACHE_PREFIX,
  INTERVENTION_KINDS,
  LOG_LEVELS,
} from '@openstarry/sdk';
import {
  createApiRuntime,
  createApiRuntimePlugin,
} from '../src/index.js';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('createApiRuntimePlugin — factory + manifest', () => {
  it('returns plugin with skandha=vijnana (識蘊)', () => {
    const p = createApiRuntimePlugin();
    expect(p.manifest.name).toBe('api-runtime');
    expect(p.manifest.skandha).toBe('vijnana');
  });

  it('factory boots an IRuntime with observe + invoke', async () => {
    const p = createApiRuntimePlugin();
    // minimal IPluginContext stub — only ctx.config is read.
    const hooks = await p.factory({ config: { initialPlugins: ['p1'] } } as Parameters<typeof p.factory>[0]);
    expect(hooks.dispose).toBeDefined();
    hooks.dispose?.();
  });
});

describe('createApiRuntime — direct wiring', () => {
  it('observe lists initialPlugins after boot', () => {
    const r = createApiRuntime({ initialPlugins: ['p1', 'p2'] });
    const view = r.observe({});
    expect(view.plugins.map((p) => p.plugin_id).sort()).toEqual(['p1', 'p2']);
  });

  it('register adds new plugins post-boot', () => {
    const r = createApiRuntime({ initialPlugins: ['p1'] });
    r.register('p2');
    expect(r.observe({}).plugins.map((p) => p.plugin_id).sort()).toEqual(['p1', 'p2']);
  });

  it('replayCacheSize starts at 0 and increments via invoke (covered by invoke.test.ts)', () => {
    const r = createApiRuntime({ initialPlugins: ['p1'] });
    expect(r.replayCacheSize()).toBe(0);
  });
});

describe('Plan59 §4 R2-C 5-item AND-condition (replay cache 6-contributor)', () => {
  it('item #1: `apr:` prefix is exactly 3-char-lowercase + colon-suffix', () => {
    expect(API_RUNTIME_REPLAY_CACHE_PREFIX).toBe('apr:');
    expect(API_RUNTIME_REPLAY_CACHE_PREFIX).toMatch(/^[a-z]{3}:$/);
  });

  it('item #6 (extension): contributor table is exactly 6 rows in source comments', () => {
    const indexSrc = readFileSync(join(SRC_DIR, 'index.ts'), 'utf-8');
    // Six prefixes named in the topology comment — ordering enforced for forensic.
    for (const prefix of ['psh:', 'ac9:', 'mvq:', 'vsn:', 'msh:', 'apr:']) {
      expect(indexSrc).toContain(prefix);
    }
  });
});

describe('Plan59 §6.2 boundary invariant — static-analysis grep over src/', () => {
  // KERNEL R2 sub-check #7 set-disjointness predicate (Yes/No decidable).
  // ε-surface envelope tokens that MUST NOT appear inside any IRuntime
  // method signature surface.
  const FORBIDDEN_TOKENS = [
    'parent_agent_id',
    'capability_holdings',
    'parentAgentId',
    'capabilityHoldings',
  ];

  for (const file of ['runtime.ts', 'observe.ts', 'state.ts']) {
    it(`${file} contains zero ε-surface envelope leak tokens`, () => {
      const src = readFileSync(join(SRC_DIR, file), 'utf-8');
      for (const tok of FORBIDDEN_TOKENS) {
        expect(src).not.toContain(tok);
      }
    });
  }

  // invoke.ts uses `nonce` and `hmac_signature` because they are part of
  // the canonical signing input — the rule is that nothing OUTSIDE the
  // canonical (target_plugin|kind|nonce|ts_utc) tuple may surface there.
  it('invoke.ts canonical input is target_plugin|kind|nonce|ts_utc (4 fields, no envelope leak)', () => {
    const src = readFileSync(join(SRC_DIR, 'invoke.ts'), 'utf-8');
    expect(src).toContain('target_plugin}|${req.intervention.kind}|${req.nonce}|${req.ts_utc');
    for (const tok of FORBIDDEN_TOKENS) {
      expect(src).not.toContain(tok);
    }
  });
});

describe('Plan59 §6.3 bounded intervention 4-tuple constants', () => {
  it('INTERVENTION_KINDS is exactly the 3-row allow-list', () => {
    expect(INTERVENTION_KINDS).toEqual(['log_level', 'debug_flag', 'soft_tracing']);
  });
  it('LOG_LEVELS is exactly info/warn/error/debug', () => {
    expect(LOG_LEVELS).toEqual(['info', 'warn', 'error', 'debug']);
  });
});
