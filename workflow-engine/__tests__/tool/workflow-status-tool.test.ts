/**
 * workflow:status tool tests (Doc 12 poll-handle closure, v0.59.7).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPluginContext, ITool } from "@openstarry/sdk";
import { WorkflowEngine } from "../../src/engine/workflow-engine.js";
import type { IWorkflowDefinition } from "../../src/types/workflow.js";
import { createWorkflowStatusTool } from "../../src/tool/workflow-status-tool.js";

function createCapturingContext(): IPluginContext {
  const echoTool: ITool = {
    id: "test:echo",
    description: "Echoes its input",
    parameters: {} as any,
    async execute(input: unknown) {
      return JSON.stringify(input);
    },
  };
  return {
    bus: { emit: () => {}, subscribe: () => () => {} },
    workingDirectory: "/tmp",
    agentId: "test-agent",
    config: {},
    pushInput: () => {},
    tools: { list: () => [echoTool], get: (id: string) => (id === "test:echo" ? echoTool : undefined) },
  } as unknown as IPluginContext;
}

const tmpDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wf-status-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const simple: IWorkflowDefinition = {
  name: "status-me",
  version: "1.0.0",
  inputs: {},
  steps: [{ name: "echo", type: "tool", tool: "test:echo", arguments: { hello: "world" } }],
  outputs: { out: "{{steps.echo}}" },
};

describe("workflow:status tool (Doc 12 poll handle)", () => {
  it("has the correct id and parameters", () => {
    const tool = createWorkflowStatusTool(new WorkflowEngine(createCapturingContext()));
    expect(tool.id).toBe("workflow:status");
    expect(tool.skandha).toBe("samskara");
  });

  it("returns the completed result for a known executionId", async () => {
    const engine = new WorkflowEngine(createCapturingContext());
    const result = await engine.execute(simple, {});
    const tool = createWorkflowStatusTool(engine);

    const out = JSON.parse(await tool.execute({ executionId: result.executionId }, {} as any));
    expect(out.executionId).toBe(result.executionId);
    expect(out.status).toBe("completed");
    expect(out.outputs).toBeDefined();
  });

  it("returns a not_found message for an unknown executionId", async () => {
    const tool = createWorkflowStatusTool(new WorkflowEngine(createCapturingContext()));
    const out = JSON.parse(await tool.execute({ executionId: "does-not-exist" }, {} as any));
    expect(out.status).toBe("not_found");
    expect(out.message).toMatch(/does-not-exist/);
  });

  it("resolves a persisted executionId from disk after a process restart (OPENSTARRY_WORKFLOW_STATE_DIR)", async () => {
    const dir = makeTempDir();
    const engine1 = new WorkflowEngine(createCapturingContext(), { persistDir: dir });
    const result = await engine1.execute(simple, {});

    // Fresh engine = simulated restart; status tool must still resolve via disk.
    const engine2 = new WorkflowEngine(createCapturingContext(), { persistDir: dir });
    const tool = createWorkflowStatusTool(engine2);
    const out = JSON.parse(await tool.execute({ executionId: result.executionId }, {} as any));
    expect(out.executionId).toBe(result.executionId);
    expect(out.status).toBe("completed");
  });
});
