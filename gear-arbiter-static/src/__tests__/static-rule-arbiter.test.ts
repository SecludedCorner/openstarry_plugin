import { describe, it, expect } from 'vitest';
import {
  createGearArbiterStaticPlugin,
  createStaticRuleEvaluator,
  DEFAULT_STATIC_RULES,
  type StaticRule,
  type StaticRuleArbiterConfig,
} from '../index.js';
import type { GearContext, IPluginContext } from '@openstarry/sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(toolNames: string[]): GearContext {
  return {
    input: 'test input',
    proposedToolCalls: toolNames.map(name => ({ name, arguments: {} })),
    actionHistory: [],
    agentConfig: { id: 'test-agent' },
  };
}

/** Minimal IPluginContext stub — only what the factory needs. */
const stubCtx: IPluginContext = {
  bus: {
    emit: () => {},
    on: () => () => {},
    off: () => {},
  } as unknown as IPluginContext['bus'],
  workingDirectory: '/tmp',
  agentId: 'test-agent',
  config: {},
  pushInput: () => {},
  sessions: {} as IPluginContext['sessions'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createStaticRuleEvaluator', () => {
  // Test 1: exact string match → correct gear + confidence
  it('returns correct gear and confidence on exact string match', () => {
    const config: StaticRuleArbiterConfig = {
      rules: [{ pattern: 'read_file', gear: 1, confidence: 0.90, riskCategory: 'read_only' }],
    };
    const evaluate = createStaticRuleEvaluator(config);
    const result = evaluate(makeContext(['read_file']));

    expect(result.action).toBe(1);
    expect(result.confidence).toBe(0.90);
  });

  // Test 2: regex match → correct gear
  it('returns correct gear on regex pattern match', () => {
    const config: StaticRuleArbiterConfig = {
      rules: [{ pattern: /^read_/, gear: 1, confidence: 0.88 }],
    };
    const evaluate = createStaticRuleEvaluator(config);
    const result = evaluate(makeContext(['read_file']));

    expect(result.action).toBe(1);
    expect(result.confidence).toBe(0.88);
  });

  // Test 3: no match → action: 'abstain'
  it("returns action 'abstain' when no rule matches", () => {
    const config: StaticRuleArbiterConfig = {
      rules: [{ pattern: 'read_file', gear: 1, confidence: 0.90 }],
    };
    const evaluate = createStaticRuleEvaluator(config);
    const result = evaluate(makeContext(['delete_file']));

    expect(result.action).toBe('abstain');
    expect(result.confidence).toBe(0);
  });

  // Test 4: worst-risk-wins semantics (replaces old first-match-wins)
  it('applies highest-risk rule when multiple rules match', () => {
    const config: StaticRuleArbiterConfig = {
      rules: [
        { pattern: 'write_file', gear: 2, confidence: 0.80, riskCategory: 'state_modifying' },
        { pattern: 'write_file', gear: 3, confidence: 0.50, riskCategory: 'destructive' },
      ],
    };
    const evaluate = createStaticRuleEvaluator(config);
    const result = evaluate(makeContext(['write_file']));

    // Must match the highest-risk rule (destructive > state_modifying)
    expect(result.action).toBe(3);
    expect(result.confidence).toBe(0.50);
    expect(result.riskCategory).toBe('destructive');
  });

  // Test 11: mixed-risk batch — worst category wins
  it('returns destructive riskCategory for a batch containing destructive + lower-risk tools', () => {
    const config: StaticRuleArbiterConfig = {
      rules: [
        { pattern: 'fs.list',   gear: 1, confidence: 0.95, riskCategory: 'informational' },
        { pattern: 'fs.write',  gear: 1, confidence: 0.70, riskCategory: 'state_modifying' },
        { pattern: 'fs.delete', gear: 1, confidence: 0.50, riskCategory: 'destructive' },
      ],
    };
    const evaluate = createStaticRuleEvaluator(config);
    const result = evaluate(makeContext(['fs.list', 'fs.write', 'fs.delete']));

    expect(result.riskCategory).toBe('destructive');
    expect(result.action).not.toBe('abstain');
  });

  // Test 12: single-tool batch still resolves correctly (regression)
  it('returns correct evaluation for a single-tool batch', () => {
    const config: StaticRuleArbiterConfig = {
      rules: [
        { pattern: 'fs.read', gear: 1, confidence: 0.90, riskCategory: 'read_only' },
      ],
    };
    const evaluate = createStaticRuleEvaluator(config);
    const result = evaluate(makeContext(['fs.read']));

    expect(result.action).toBe(1);
    expect(result.confidence).toBe(0.90);
    expect(result.riskCategory).toBe('read_only');
  });

  // Test 5: riskCategory correctly passed through
  it('passes riskCategory from the matched rule through to GearEvaluation', () => {
    const config: StaticRuleArbiterConfig = {
      rules: [{ pattern: 'write_file', gear: 1, confidence: 0.70, riskCategory: 'state_modifying' }],
    };
    const evaluate = createStaticRuleEvaluator(config);
    const result = evaluate(makeContext(['write_file']));

    expect(result.riskCategory).toBe('state_modifying');
  });

  // Test 6: multiple tool calls — any match triggers rule
  it('triggers rule when any of multiple proposed tool calls matches', () => {
    const config: StaticRuleArbiterConfig = {
      rules: [{ pattern: 'list_files', gear: 1, confidence: 0.95 }],
    };
    const evaluate = createStaticRuleEvaluator(config);
    // Only the second tool call matches
    const result = evaluate(makeContext(['search_code', 'list_files']));

    expect(result.action).toBe(1);
    expect(result.confidence).toBe(0.95);
  });

  // Test 7: empty rules → always abstain
  it('always abstains when rules array is empty', () => {
    const evaluate = createStaticRuleEvaluator({ rules: [] });
    const result = evaluate(makeContext(['read_file']));

    expect(result.action).toBe('abstain');
  });
});

describe('createGearArbiterStaticPlugin', () => {
  // Test 8: plugin factory returns gearArbiters hook
  it('factory returns PluginHooks with a non-empty gearArbiters array', async () => {
    const plugin = createGearArbiterStaticPlugin();
    const hooks = await plugin.factory(stubCtx);

    expect(Array.isArray(hooks.gearArbiters)).toBe(true);
    expect(hooks.gearArbiters!.length).toBeGreaterThan(0);
  });

  // Test 9: plugin manifest has correct skandha
  it('manifest declares skandha as [samjna, vijnana]', () => {
    const plugin = createGearArbiterStaticPlugin();
    const { skandha } = plugin.manifest;

    expect(skandha).toEqual(['samjna', 'vijnana']);
  });

  // Test 10: default rules match read_file, list_files, search_code, write_file
  it('default rules produce non-abstain evaluations for all four default tool names', () => {
    const plugin = createGearArbiterStaticPlugin();
    // The arbiter returned by the factory wraps createStaticRuleEvaluator(DEFAULT_STATIC_RULES).
    // We can directly test the evaluator for the same coverage.
    const evaluate = createStaticRuleEvaluator({ rules: DEFAULT_STATIC_RULES });

    const toolNames = ['read_file', 'list_files', 'search_code', 'write_file'];
    for (const name of toolNames) {
      const result = evaluate(makeContext([name]));
      expect(result.action).not.toBe('abstain');
    }

    // Manifest name sanity check while we're here
    expect(plugin.manifest.name).toBe('@openstarry-plugin/gear-arbiter-static');
  });
});
