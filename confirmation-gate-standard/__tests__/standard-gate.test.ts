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

  // V-2 note: these ask_user contract tests now inject interactive: true —
  // the test runner has no TTY, and the V-2 fail-closed default would
  // (intentionally) turn ask_user into deny. Semantics under an interactive
  // session are unchanged.
  it("T3-T10: alwaysConfirmTools overrides bypass category", () => {
    const gate = createStandardConfirmationGate({
      alwaysConfirmTools: ['fs.read'],
      interactive: true,
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
      interactive: true,
    });
    const decision = gate.evaluate(makeRequest({ toolName: 'fs.write' }));
    expect(decision.action).toBe('ask_user');
  });

  it("default: ask_user for non-bypassed tools", () => {
    const gate = createStandardConfirmationGate({
      bypassCategories: [],
      bypassGears: [],
      interactive: true,
    });
    const decision = gate.evaluate(makeRequest());
    expect(decision.action).toBe('ask_user');
  });
});

describe("StandardConfirmationGate — V-2 fail-closed + timeout config", () => {
  it("non-interactive: every would-be ask_user becomes an immediate deny (no hang)", () => {
    const gate = createStandardConfirmationGate({
      bypassCategories: [],
      bypassGears: [],
      interactive: false,
    });
    const d = gate.evaluate(makeRequest());
    expect(d.action).toBe('deny');
    expect(d.reasoning).toContain('non-interactive');
  });

  it("non-interactive: alwaysConfirmTools also fail closed", () => {
    const gate = createStandardConfirmationGate({
      alwaysConfirmTools: ['fs.read'],
      interactive: false,
    });
    const d = gate.evaluate(makeRequest({ toolName: 'fs.read', riskCategory: 'read_only' }));
    expect(d.action).toBe('deny');
  });

  it("non-interactive: bypasses still approve (fail-closed only affects prompting)", () => {
    const gate = createStandardConfirmationGate({ interactive: false });
    const d = gate.evaluate(makeRequest({ riskCategory: 'read_only' }));
    expect(d.action).toBe('approve');
  });

  it("userPromptTimeoutMs from config is carried on the ask_user decision", () => {
    const gate = createStandardConfirmationGate({
      bypassCategories: [],
      bypassGears: [],
      interactive: true,
      userPromptTimeoutMs: 45000,
    });
    const d = gate.evaluate(makeRequest());
    expect(d.action).toBe('ask_user');
    expect(d.timeoutMs).toBe(45000);
  });
});

describe("StandardConfirmationGate — properties", () => {
  it("has correct skandha and id", () => {
    const gate = createStandardConfirmationGate();
    expect(gate.skandha).toBe('samskara');
    expect(gate.id).toBe('standard-confirmation-gate');
  });

  it("T3-T11: evaluates each request independently (no state)", () => {
    const gate = createStandardConfirmationGate({
      bypassCategories: [],
      bypassGears: [],
      interactive: true, // V-2: test runner has no TTY (see note above)
    });

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

describe("V-2 deny → model feedback bridge (pushInput via existing seam)", () => {
  type Handler = (event: { type: string; payload?: unknown }) => void;

  function stubCtx() {
    const handlers = new Map<string, Handler[]>();
    const pushed: Array<{ inputType: string; data: unknown }> = [];
    return {
      pushed,
      fire(type: string, payload: unknown) {
        for (const h of handlers.get(type) ?? []) h({ type, payload });
      },
      ctx: {
        bus: {
          on: (type: string, h: Handler) => {
            handlers.set(type, [...(handlers.get(type) ?? []), h]);
            return () => {};
          },
          emit: () => {},
        },
        workingDirectory: "/tmp",
        agentId: "t",
        config: {},
        pushInput: (e: { inputType: string; data: unknown }) => pushed.push(e),
        sessions: {},
      } as never,
    };
  }

  it("a confirmation denial pushes a model-visible note; a volition veto does NOT", async () => {
    const { createConfirmationGateStandardPlugin } = await import("../src/index.js");
    const s = stubCtx();
    await createConfirmationGateStandardPlugin({ interactive: false }).factory(s.ctx);

    s.fire("tool:blocked", { name: "fs.write", reason: "User denied: not now" });
    expect(s.pushed).toHaveLength(1);
    expect(String(s.pushed[0].data)).toContain("DECLINED");
    expect(String(s.pushed[0].data)).toContain("fs.write");

    s.fire("tool:blocked", { name: "fs.read", reason: "volition veto (plan): hard rule" });
    expect(s.pushed).toHaveLength(1); // unchanged — volition vetoes are not confirm denials
  });

  it("dedupes repeated denials of the same tool within the window", async () => {
    const { createConfirmationGateStandardPlugin } = await import("../src/index.js");
    const s = stubCtx();
    await createConfirmationGateStandardPlugin({ interactive: false }).factory(s.ctx);
    s.fire("tool:blocked", { name: "fs.write", reason: "Confirmation timeout (default-deny)" });
    s.fire("tool:blocked", { name: "fs.write", reason: "Confirmation timeout (default-deny)" });
    expect(s.pushed).toHaveLength(1);
  });

  it("notifyModelOnDeny: false disables the bridge", async () => {
    const { createConfirmationGateStandardPlugin } = await import("../src/index.js");
    const s = stubCtx();
    await createConfirmationGateStandardPlugin({
      interactive: false,
      notifyModelOnDeny: false,
    }).factory(s.ctx);
    s.fire("tool:blocked", { name: "fs.write", reason: "User denied: nope" });
    expect(s.pushed).toHaveLength(0);
  });
});
