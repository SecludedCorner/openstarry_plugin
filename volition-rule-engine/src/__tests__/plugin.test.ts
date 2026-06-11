import { describe, it, expect } from "vitest";
import { createVolitionRuleEnginePlugin } from "../index.js";
import type { IPluginContext, EventBus, ISessionManager } from "@openstarry/sdk";

function stubCtx(): IPluginContext {
  return {
    bus: { emit: () => {}, on: () => () => {} } as unknown as EventBus,
    workingDirectory: "/tmp",
    agentId: "test-agent",
    config: {},
    pushInput: () => {},
    sessions: {} as ISessionManager,
  };
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
});
