import { describe, it, expect, beforeEach } from "vitest";
import { createDevtoolsCommand, type DevToolsPanelControl } from "../../src/commands/devtools.js";
import { createMetricsCommand } from "../../src/commands/metrics.js";
import { createDebugCommand } from "../../src/commands/debug.js";
import { MetricsCollector } from "../../src/metrics/collector.js";
import type { DevToolsConfig } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

function createMockCtx(): any {
  return {
    bus: { onAny: () => () => {}, emit: () => {} },
    sessions: { list: () => [], getDefaultSession: () => null },
    pushInput: () => {},
    workingDirectory: "/tmp",
    agentId: "test",
    config: {},
  };
}

describe("/devtools command", () => {
  let visible = false;
  const mockPanel: DevToolsPanelControl = {
    toggle: () => { visible = !visible; return visible; },
    isVisible: () => visible,
  };

  beforeEach(() => { visible = false; });

  it("should toggle panel ON", async () => {
    const cmd = createDevtoolsCommand(mockPanel);
    const result = await cmd.execute("", createMockCtx());
    expect(result).toContain("ON");
    expect(visible).toBe(true);
  });

  it("should toggle panel OFF", async () => {
    visible = true;
    const cmd = createDevtoolsCommand(mockPanel);
    const result = await cmd.execute("", createMockCtx());
    expect(result).toContain("OFF");
    expect(visible).toBe(false);
  });

  it("should have correct name and description", () => {
    const cmd = createDevtoolsCommand(mockPanel);
    expect(cmd.name).toBe("devtools");
    expect(cmd.description).toBeTruthy();
  });
});

describe("/metrics command", () => {
  it("should output metrics snapshot", async () => {
    const collector = new MetricsCollector();
    collector.increment("test.counter", 42);
    const cmd = createMetricsCommand(collector);
    const result = await cmd.execute("", createMockCtx());
    expect(result).toContain("DevTools Metrics Snapshot");
    expect(result).toContain("test.counter");
  });

  it("should show empty metrics", async () => {
    const collector = new MetricsCollector();
    const cmd = createMetricsCommand(collector);
    const result = await cmd.execute("", createMockCtx());
    expect(result).toContain("DevTools Metrics Snapshot");
    expect(result).toContain("Counters:");
  });
});

describe("/debug command", () => {
  let config: Required<DevToolsConfig>;

  beforeEach(() => {
    config = { ...DEFAULT_CONFIG };
  });

  it("should enable verbose logging with 'on'", async () => {
    const cmd = createDebugCommand(config);
    const result = await cmd.execute("on", createMockCtx());
    expect(result).toContain("ON");
    expect(config.verbose).toBe(true);
  });

  it("should disable verbose logging with 'off'", async () => {
    config.verbose = true;
    const cmd = createDebugCommand(config);
    const result = await cmd.execute("off", createMockCtx());
    expect(result).toContain("OFF");
    expect(config.verbose).toBe(false);
  });

  it("should show current state with no args", async () => {
    config.verbose = true;
    const cmd = createDebugCommand(config);
    const result = await cmd.execute("", createMockCtx());
    expect(result).toContain("ON");
  });

  it("should show OFF state with no args when disabled", async () => {
    const cmd = createDebugCommand(config);
    const result = await cmd.execute("", createMockCtx());
    expect(result).toContain("OFF");
  });
});
