import { describe, it, expect } from "vitest";
import { createRuleEngineVolition, DEFAULT_VOLITION_RULE_ENGINE_CONFIG } from "../rule-engine.js";
import type { VolitionRuleEngineConfig } from "../rule-engine.js";
import type {
  PlanDeliberationInput,
  ActionDeliberationInput,
  KleshaSignalBundle,
  VedanaAssessment,
  ChannelVedana,
  DeliberationContext,
  RouteResult,
  ActionRecord,
} from "@openstarry/sdk";

// Helpers
function makeKleshaSignals(): KleshaSignalBundle {
  return { moha: 0, drishti: 0, mana: 0, sneha: 0 };
}

function makeVedana(): VedanaAssessment {
  const ch: ChannelVedana = { valence: 0, intensity: 0, type: "upekkha", source: "test" };
  return { aggregate: ch, channels: [ch], pidOutput: 0, timestamp: Date.now() };
}

function makeRouteResult(overrides?: Partial<RouteResult>): RouteResult {
  return { gear: 2, confidence: 0.8, riskAdjusted: false, ...overrides };
}

function makeContext(riskCategory?: string, history?: ActionRecord[]): DeliberationContext {
  return {
    routeResult: makeRouteResult(riskCategory ? { riskCategory: riskCategory as any } : {}),
    actionHistory: history ?? [],
  };
}

function makePlanInput(
  actions: string[],
  ctx?: DeliberationContext,
): PlanDeliberationInput {
  return {
    proposedActions: actions.map(name => ({ name, arguments: {} })),
    kleshaSignals: makeKleshaSignals(),
    vedanaAssessment: makeVedana(),
    deliberationContext: ctx,
  };
}

function makeActionInput(
  name: string,
  ctx?: DeliberationContext,
): ActionDeliberationInput {
  return {
    proposedAction: { name, arguments: {} },
    kleshaSignals: makeKleshaSignals(),
    vedanaAssessment: makeVedana(),
    planContext: { modifiedPlan: null, reasoning: "test" },
    deliberationContext: ctx,
  };
}

describe("volition-rule-engine", () => {
  describe("hard rules", () => {
    it("vetoes destructive riskCategory", async () => {
      const vol = createRuleEngineVolition();
      const result = await vol.deliberateAction(
        makeActionInput("fs.delete", makeContext("destructive")),
      );
      expect(result.veto).toBe(true);
      expect(result.reasoning).toContain("destructive");
    });

    it("vetoes state_modifying riskCategory", async () => {
      const vol = createRuleEngineVolition();
      const result = await vol.deliberateAction(
        makeActionInput("fs.write", makeContext("state_modifying")),
      );
      expect(result.veto).toBe(true);
    });

    it("allows read_only riskCategory", async () => {
      const vol = createRuleEngineVolition();
      const result = await vol.deliberateAction(
        makeActionInput("fs.read", makeContext("read_only")),
      );
      expect(result.veto).toBe(false);
    });

    it("allows informational riskCategory", async () => {
      const vol = createRuleEngineVolition();
      const result = await vol.deliberateAction(
        makeActionInput("help", makeContext("informational")),
      );
      expect(result.veto).toBe(false);
    });
  });

  describe("soft rules", () => {
    it("vetoes matching pattern", async () => {
      const config: VolitionRuleEngineConfig = {
        ...DEFAULT_VOLITION_RULE_ENGINE_CONFIG,
        softRules: [{ pattern: "danger", action: "veto", reasoning: "danger pattern" }],
      };
      const vol = createRuleEngineVolition(config);
      const result = await vol.deliberateAction(
        makeActionInput("danger-tool", makeContext("read_only")),
      );
      expect(result.veto).toBe(true);
      expect(result.reasoning).toContain("danger pattern");
    });

    it("allows matching allow pattern", async () => {
      const config: VolitionRuleEngineConfig = {
        hardRules: [],
        softRules: [{ pattern: "safe", action: "allow", reasoning: "safe tool" }],
        heuristicRules: [],
      };
      const vol = createRuleEngineVolition(config);
      const result = await vol.deliberateAction(
        makeActionInput("safe-tool", makeContext("read_only")),
      );
      expect(result.veto).toBe(false);
    });

    it("supports RegExp patterns", async () => {
      const config: VolitionRuleEngineConfig = {
        hardRules: [],
        softRules: [{ pattern: /^fs\.delete/, action: "veto", reasoning: "no fs.delete" }],
        heuristicRules: [],
      };
      const vol = createRuleEngineVolition(config);
      const result = await vol.deliberateAction(
        makeActionInput("fs.delete", makeContext("read_only")),
      );
      expect(result.veto).toBe(true);
    });
  });

  describe("heuristic rules", () => {
    it("vetoes repetitive tool usage", async () => {
      const history: ActionRecord[] = Array.from({ length: 6 }, (_, i) => ({
        name: "fs.read",
        success: true,
        timestamp: Date.now() - (6 - i) * 1000,
      }));
      const vol = createRuleEngineVolition();
      const result = await vol.deliberateAction(
        makeActionInput("fs.read", makeContext("read_only", history)),
      );
      expect(result.veto).toBe(true);
      expect(result.reasoning).toContain("Heuristic");
    });

    it("allows when below repetition threshold", async () => {
      const history: ActionRecord[] = [
        { name: "fs.read", success: true, timestamp: Date.now() },
        { name: "fs.write", success: true, timestamp: Date.now() },
      ];
      const vol = createRuleEngineVolition();
      const result = await vol.deliberateAction(
        makeActionInput("fs.read", makeContext("read_only", history)),
      );
      expect(result.veto).toBe(false);
    });
  });

  describe("three-layer precedence", () => {
    it("hard rule takes precedence over soft allow", async () => {
      const config: VolitionRuleEngineConfig = {
        hardRules: [{ mustAuditCategories: ["destructive"] }],
        softRules: [{ pattern: "fs.delete", action: "allow", reasoning: "allow fs.delete" }],
        heuristicRules: [],
      };
      const vol = createRuleEngineVolition(config);
      const result = await vol.deliberateAction(
        makeActionInput("fs.delete", makeContext("destructive")),
      );
      expect(result.veto).toBe(true);
      expect(result.reasoning).toContain("Hard rule");
    });
  });

  describe("backward compatibility", () => {
    it("allows all when no deliberationContext (v0 compat)", async () => {
      const vol = createRuleEngineVolition();
      const result = await vol.deliberateAction(
        makeActionInput("fs.delete"),
      );
      expect(result.veto).toBe(false);
      expect(result.reasoning).toContain("v0 compat");
    });

    it("plan allows all when no deliberationContext", async () => {
      const vol = createRuleEngineVolition();
      const result = await vol.deliberatePlan(
        makePlanInput(["fs.delete", "fs.write"]),
      );
      expect(result.modifiedPlan).toBeNull();
    });
  });

  describe("deliberatePlan", () => {
    it("filters plan based on rules", async () => {
      const vol = createRuleEngineVolition();
      const ctx = makeContext("destructive");
      const result = await vol.deliberatePlan(
        makePlanInput(["fs.read", "fs.delete"], ctx),
      );
      // Both have same riskCategory from routeResult, so both get vetoed by hard rule
      expect(result.modifiedPlan).toBeDefined();
      expect(result.modifiedPlan).toHaveLength(0);
    });

    it("keeps allowed actions in plan", async () => {
      const config: VolitionRuleEngineConfig = {
        hardRules: [],
        softRules: [{ pattern: "danger", action: "veto", reasoning: "blocked" }],
        heuristicRules: [],
      };
      const vol = createRuleEngineVolition(config);
      const ctx = makeContext("read_only");
      const result = await vol.deliberatePlan(
        makePlanInput(["fs.read", "danger-tool"], ctx),
      );
      expect(result.modifiedPlan).toHaveLength(1);
      expect(result.modifiedPlan![0].name).toBe("fs.read");
    });
  });

  describe("defaultRiskCategory [Y1]", () => {
    it("uses defaultRiskCategory when routeResult has no riskCategory", async () => {
      const config: VolitionRuleEngineConfig = {
        hardRules: [{ mustAuditCategories: ["destructive"] }],
        softRules: [],
        heuristicRules: [],
        defaultRiskCategory: "destructive",
      };
      const vol = createRuleEngineVolition(config);
      // RouteResult without riskCategory
      const ctx: DeliberationContext = {
        routeResult: makeRouteResult(),
        actionHistory: [],
      };
      const result = await vol.deliberateAction(
        makeActionInput("any-tool", ctx),
      );
      expect(result.veto).toBe(true);
    });

    it("defaults to read_only when no config default", async () => {
      const config: VolitionRuleEngineConfig = {
        hardRules: [{ mustAuditCategories: ["destructive"] }],
        softRules: [],
        heuristicRules: [],
        // No defaultRiskCategory
      };
      const vol = createRuleEngineVolition(config);
      const ctx: DeliberationContext = {
        routeResult: makeRouteResult(),
        actionHistory: [],
      };
      const result = await vol.deliberateAction(
        makeActionInput("any-tool", ctx),
      );
      // read_only is not in mustAuditCategories, so should pass
      expect(result.veto).toBe(false);
    });
  });
});
