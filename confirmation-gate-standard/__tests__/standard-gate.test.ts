/**
 * Tests for StandardConfirmationGate.
 * @see Plan36b §3.5, §7.1
 */
import { describe, it, expect } from "vitest";
import { createStandardConfirmationGate } from "../src/standard-gate.js";
import type { ConfirmationRequest, RiskCategory } from "@openstarry/sdk";

function makeRequest(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    toolCallId: 'tc-1',
    toolName: 'fs.write',
    toolArguments: { path: '/tmp/test.txt', content: 'hello' },
    riskCategory: 'state_modifying' as RiskCategory,
    gear: 2,
    sessionId: 'session-1',
    ...overrides,
  };
}

describe("StandardConfirmationGate — bypass rules", () => {
  it("T3-T8: auto-approves informational tools (bypassCategories)", () => {
    const gate = createStandardConfirmationGate();
    const decision = gate.evaluate(makeRequest({ riskCategory: 'informational' }));
    expect(decision.action).toBe('approve');
  });

  it("T3-T9: auto-approves gear 1 (bypassGears)", () => {
    const gate = createStandardConfirmationGate();
    const decision = gate.evaluate(makeRequest({ gear: 1 }));
    expect(decision.action).toBe('approve');
  });

  it("T3-T14: neverConfirmTools bypass", () => {
    const gate = createStandardConfirmationGate({
      neverConfirmTools: ['fs.write'],
    });
    const decision = gate.evaluate(makeRequest());
    expect(decision.action).toBe('approve');
  });

  it("T3-T10: alwaysConfirmTools overrides bypass category", () => {
    const gate = createStandardConfirmationGate({
      alwaysConfirmTools: ['fs.read'],
    });
    const decision = gate.evaluate(makeRequest({
      toolName: 'fs.read',
      riskCategory: 'read_only',
    }));
    expect(decision.action).toBe('ask_user');
  });

  it("T3-T15: alwaysConfirm > neverConfirm priority", () => {
    const gate = createStandardConfirmationGate({
      alwaysConfirmTools: ['fs.write'],
      neverConfirmTools: ['fs.write'],
    });
    const decision = gate.evaluate(makeRequest({ toolName: 'fs.write' }));
    expect(decision.action).toBe('ask_user');
  });

  it("default: ask_user for non-bypassed tools", () => {
    const gate = createStandardConfirmationGate({
      bypassCategories: [],
      bypassGears: [],
    });
    const decision = gate.evaluate(makeRequest());
    expect(decision.action).toBe('ask_user');
  });
});

describe("StandardConfirmationGate — properties", () => {
  it("has correct skandha and id", () => {
    const gate = createStandardConfirmationGate();
    expect(gate.skandha).toBe('samskara');
    expect(gate.id).toBe('standard-confirmation-gate');
  });

  it("T3-T11: evaluates each request independently (no state)", () => {
    const gate = createStandardConfirmationGate({ bypassCategories: [], bypassGears: [] });

    const d1 = gate.evaluate(makeRequest({ toolName: 'fs.write' }));
    const d2 = gate.evaluate(makeRequest({ toolName: 'fs.delete' }));
    expect(d1.action).toBe('ask_user');
    expect(d2.action).toBe('ask_user');
  });
});

describe("StandardConfirmationGate — plugin integration", () => {
  it("createConfirmationGateStandardPlugin returns valid plugin", async () => {
    const { createConfirmationGateStandardPlugin } = await import("../src/index.js");
    const plugin = createConfirmationGateStandardPlugin();
    expect(plugin.manifest.skandha).toBe('samskara');
    expect(plugin.manifest.criticality).toBe('optional-no-effect');
  });
});
