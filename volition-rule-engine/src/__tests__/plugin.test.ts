import { describe, it, expect } from "vitest";
import { createVolitionRuleEnginePlugin } from "../index.js";
import type {
  IPluginContext,
  EventBus,
  ISessionManager,
  AgentEvent,
  DeliberationContext,
} from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";

function stubCtx(config: Record<string, unknown> = {}): IPluginContext & { emitted: AgentEvent[] } {
  const emitted: AgentEvent[] = [];
  return {
    emitted,
    bus: { emit: (e: AgentEvent) => { emitted.push(e); }, on: () => () => {} } as unknown as EventBus,
    workingDirectory: "/tmp",
    agentId: "test-agent",
    config,
    pushInput: () => {},
    sessions: {} as ISessionManager,
  };
}

/** A deliberation context whose routeResult tags the call state_modifying (hard-rule target). */
function stateModifyingContext(): DeliberationContext {
  return {
    routeResult: { riskCategory: "state_modifying" },
    actionHistory: [],
  } as unknown as DeliberationContext;
}

describe("createVolitionRuleEnginePlugin", () => {
  it("returns valid IPlugin with manifest", () => {
    const plugin = createVolitionRuleEnginePlugin();
    expect(plugin.manifest.name).toBe("volition-rule-engine");
    expect(plugin.manifest.skandha).toBe("vijnana");
  });

  it("factory returns PluginHooks with volition", async () => {
    const plugin = createVolitionRuleEnginePlugin();
    const hooks = await plugin.factory(stubCtx());
    expect(hooks.volition).toBeDefined();
    expect(typeof hooks.volition!.deliberatePlan).toBe("function");
    expect(typeof hooks.volition!.deliberateAction).toBe("function");
  });

  // V-1: veto observability + ctx.config wiring
  it("emits TOOL_BLOCKED when a plan-level hard-rule veto drops a call (no more silent filter)", async () => {
    const ctx = stubCtx();
    const hooks = await createVolitionRuleEnginePlugin().factory(ctx);
    const result = await hooks.volition!.deliberatePlan({
      proposedActions: [{ name: "fs.write", arguments: {} }],
      kleshaSignals: [],
      vedanaAssessment: undefined,
      sessionId: "s1",
      deliberationContext: stateModifyingContext(),
    } as never);

    expect(result.modifiedPlan).toEqual([]); // dropped by the hard rule
    const blocked = ctx.emitted.filter((e) => e.type === AgentEventType.TOOL_BLOCKED);
    expect(blocked).toHaveLength(1);
    const payload = blocked[0].payload as { name?: string; reason?: string };
    expect(payload.name).toBe("fs.write");
    expect(payload.reason).toContain("volition veto (plan)");
  });

  it("emits TOOL_BLOCKED on a per-action veto", async () => {
    const ctx = stubCtx();
    const hooks = await createVolitionRuleEnginePlugin().factory(ctx);
    const result = await hooks.volition!.deliberateAction({
      proposedAction: { name: "fs.delete", arguments: {} },
      kleshaSignals: [],
      vedanaAssessment: undefined,
      planContext: { modifiedPlan: null, reasoning: "" },
      deliberationContext: {
        routeResult: { riskCategory: "destructive" },
        actionHistory: [],
      },
    } as never);

    expect(result.veto).toBe(true);
    const blocked = ctx.emitted.filter((e) => e.type === AgentEventType.TOOL_BLOCKED);
    expect(blocked).toHaveLength(1);
    expect((blocked[0].payload as { reason?: string }).reason).toContain("volition veto (action)");
  });

  it("honors ctx.config: hardRules [] disables the veto (agent.json wins) and nothing is emitted", async () => {
    const ctx = stubCtx({ hardRules: [] });
    const hooks = await createVolitionRuleEnginePlugin().factory(ctx);
    const result = await hooks.volition!.deliberatePlan({
      proposedActions: [{ name: "fs.write", arguments: {} }],
      kleshaSignals: [],
      vedanaAssessment: undefined,
      sessionId: "s1",
      deliberationContext: stateModifyingContext(),
    } as never);

    expect(result.modifiedPlan).toBeNull(); // nothing filtered
    expect(ctx.emitted.filter((e) => e.type === AgentEventType.TOOL_BLOCKED)).toHaveLength(0);
  });

  // V-2: mode config
  it("mode 'confirm': hard-rule hits pass through (no veto, no emit) so the gate can ask", async () => {
    const ctx = stubCtx({ mode: "confirm" });
    const hooks = await createVolitionRuleEnginePlugin().factory(ctx);
    const result = await hooks.volition!.deliberatePlan({
      proposedActions: [{ name: "fs.write", arguments: {} }],
      kleshaSignals: [],
      vedanaAssessment: undefined,
      sessionId: "s1",
      deliberationContext: stateModifyingContext(),
    } as never);
    expect(result.modifiedPlan).toBeNull(); // not filtered — deferred to the confirmation gate
    expect(ctx.emitted).toHaveLength(0);
  });

  it("mode 'confirm': the heuristic anti-loop still vetoes (only hard rules are deferred)", async () => {
    const ctx = stubCtx({ mode: "confirm" });
    const hooks = await createVolitionRuleEnginePlugin().factory(ctx);
    const repeats = Array.from({ length: 6 }, () => ({ name: "fs.write" }));
    const result = await hooks.volition!.deliberateAction({
      proposedAction: { name: "fs.write", arguments: {} },
      kleshaSignals: [],
      vedanaAssessment: undefined,
      planContext: { modifiedPlan: null, reasoning: "" },
      deliberationContext: {
        routeResult: { riskCategory: "state_modifying" },
        actionHistory: repeats,
      },
    } as never);
    expect(result.veto).toBe(true);
    expect(result.reasoning).toContain("Heuristic");
  });

  it("mode 'allow': hard rules disabled entirely", async () => {
    const ctx = stubCtx({ mode: "allow" });
    const hooks = await createVolitionRuleEnginePlugin().factory(ctx);
    const result = await hooks.volition!.deliberateAction({
      proposedAction: { name: "fs.delete", arguments: {} },
      kleshaSignals: [],
      vedanaAssessment: undefined,
      planContext: { modifiedPlan: null, reasoning: "" },
      deliberationContext: {
        routeResult: { riskCategory: "destructive" },
        actionHistory: [],
      },
    } as never);
    expect(result.veto).toBe(false);
  });

  it("allowed calls emit nothing (observability only fires on veto)", async () => {
    const ctx = stubCtx();
    const hooks = await createVolitionRuleEnginePlugin().factory(ctx);
    await hooks.volition!.deliberateAction({
      proposedAction: { name: "fs.read", arguments: {} },
      kleshaSignals: [],
      vedanaAssessment: undefined,
      planContext: { modifiedPlan: null, reasoning: "" },
      deliberationContext: {
        routeResult: { riskCategory: "read_only" },
        actionHistory: [],
      },
    } as never);
    expect(ctx.emitted).toHaveLength(0);
  });
});
