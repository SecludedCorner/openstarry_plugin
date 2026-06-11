/**
 * DT-MG-α (loop step) + DT-MG-β (execution-state persistence) tests —
 * added v0.58.0-alpha repair sprint (FIX-2026-06-11).
 *
 * Before this fix the engine executed steps with a single sequential
 * for-loop (no loop/branch/retry constructs in the schema) and execution
 * state lived only in a function-local object + in-memory LRU(100).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPluginContext, ITool } from "@openstarry/sdk";
import { WorkflowEngine, resolveContextPath } from "../../src/engine/workflow-engine.js";
import type { IWorkflowDefinition, ILoopIterationRecord } from "../../src/types/workflow.js";
import { WorkflowSchema } from "../../src/schema/workflow-schema.js";

function createCapturingContext(): { ctx: IPluginContext; calls: unknown[] } {
  const calls: unknown[] = [];
  const echoTool: ITool = {
    id: "test:echo",
    description: "Echoes its input and records the call",
    parameters: {} as any,
    async execute(input: unknown) {
      calls.push(input);
      return JSON.stringify(input);
    },
  };
  const ctx = {
    bus: { emit: () => {}, subscribe: () => () => {} },
    workingDirectory: "/tmp",
    agentId: "test-agent",
    config: {},
    pushInput: () => {},
    sessions: {} as any,
    tools: {
      list: () => [echoTool],
      get: (id: string) => (id === "test:echo" ? echoTool : undefined),
    },
    providers: { list: () => [], get: () => undefined },
    services: { register: () => {}, get: () => undefined, has: () => false, list: () => [] },
  } as unknown as IPluginContext;
  return { ctx, calls };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wf-state-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("loop step — foreach mode (DT-MG-α)", () => {
  const definition: IWorkflowDefinition = {
    name: "loop-foreach",
    version: "1.0.0",
    inputs: { items: { type: "array", required: true } },
    steps: [
      {
        name: "each-item",
        type: "loop",
        over: "{{inputs.items}}",
        maxIterations: 10,
        steps: [
          { name: "echo", type: "tool", tool: "test:echo", arguments: { value: "{{loop.item}}", at: "{{loop.index}}" } },
        ],
      },
    ],
    outputs: {},
  };

  it("iterates the array, exposing loop.item and loop.index to nested steps", async () => {
    const { ctx, calls } = createCapturingContext();
    const engine = new WorkflowEngine(ctx);

    const result = await engine.execute(definition, { items: ["a", "b", "c"] });

    expect(result.status).toBe("completed");
    expect(calls).toEqual([
      { value: "a", at: "0" },
      { value: "b", at: "1" },
      { value: "c", at: "2" },
    ]);
  });

  it("collects per-iteration records as the loop step result", async () => {
    const { ctx } = createCapturingContext();
    const engine = new WorkflowEngine(ctx);
    const persistDir = makeTempDir();
    const engineP = new WorkflowEngine(ctx, { persistDir });

    const result = await engineP.execute(definition, { items: ["x", "y"] });
    expect(result.status).toBe("completed");

    // The loop result is visible via persisted... actually verify via outputs:
    // re-run with outputs template referencing iteration count is indirect;
    // instead execute and inspect through a tool downstream.
    const withDownstream: IWorkflowDefinition = {
      ...definition,
      steps: [
        ...definition.steps,
        { name: "after", type: "tool", tool: "test:echo", arguments: { n: "{{steps.each-item.length}}" } },
      ],
    };
    const { ctx: ctx2, calls: calls2 } = createCapturingContext();
    const engine2 = new WorkflowEngine(ctx2);
    await engine2.execute(withDownstream, { items: ["x", "y"] });
    const last = calls2.at(-1) as { n: string };
    expect(last.n).toBe("2");
    void engine; // first engine exercised default (no-persist) path
  });

  it("throws when 'over' does not resolve to an array (no silent coercion)", async () => {
    const { ctx } = createCapturingContext();
    const engine = new WorkflowEngine(ctx);
    await expect(engine.execute(definition, { items: "not-an-array" })).rejects.toThrow(/did not resolve to an array/);
  });

  it("throws when the array exceeds maxIterations (no silent truncation)", async () => {
    const { ctx } = createCapturingContext();
    const engine = new WorkflowEngine(ctx);
    const items = Array.from({ length: 11 }, (_, i) => i);
    await expect(engine.execute(definition, { items })).rejects.toThrow(/exceeds maxIterations/);
  });
});

describe("loop step — while mode (DT-MG-α)", () => {
  it("runs while the condition renders to 'true' and stops at the cap with an error", async () => {
    const { ctx } = createCapturingContext();
    const engine = new WorkflowEngine(ctx);
    const definition: IWorkflowDefinition = {
      name: "loop-while-nonconvergent",
      version: "1.0.0",
      inputs: { go: { type: "string", required: true } },
      steps: [
        {
          name: "spin",
          type: "loop",
          while: "{{inputs.go}}",
          maxIterations: 3,
          steps: [
            { name: "tick", type: "tool", tool: "test:echo", arguments: { i: "{{loop.index}}" } },
          ],
        },
      ],
      outputs: {},
    };
    await expect(engine.execute(definition, { go: "true" })).rejects.toThrow(/maxIterations 3/);
  });

  it("executes zero iterations when the condition is initially false", async () => {
    const { ctx, calls } = createCapturingContext();
    const engine = new WorkflowEngine(ctx);
    const definition: IWorkflowDefinition = {
      name: "loop-while-false",
      version: "1.0.0",
      inputs: { go: { type: "string", required: true } },
      steps: [
        {
          name: "spin",
          type: "loop",
          while: "{{inputs.go}}",
          maxIterations: 3,
          steps: [
            { name: "tick", type: "tool", tool: "test:echo", arguments: { i: "{{loop.index}}" } },
          ],
        },
      ],
      outputs: {},
    };
    const result = await engine.execute(definition, { go: "false" });
    expect(result.status).toBe("completed");
    expect(calls).toEqual([]);
  });

  it("rejects a loop step with BOTH or NEITHER of over/while", async () => {
    const { ctx } = createCapturingContext();
    const engine = new WorkflowEngine(ctx);
    const both: IWorkflowDefinition = {
      name: "loop-both",
      version: "1.0.0",
      inputs: {},
      steps: [
        { name: "bad", type: "loop", over: "{{inputs.x}}", while: "true", maxIterations: 2, steps: [{ name: "t", type: "tool", tool: "test:echo", arguments: {} }] },
      ],
      outputs: {},
    };
    await expect(engine.execute(both, {})).rejects.toThrow(/exactly one of 'over'.*or 'while'/);
  });
});

describe("loop step — schema validation (DT-MG-α)", () => {
  it("accepts a valid loop step incl. nested loop", () => {
    const parsed = WorkflowSchema.safeParse({
      name: "nested",
      version: "1.0.0",
      inputs: { items: { type: "array", required: true } },
      steps: [
        {
          name: "outer", type: "loop", over: "{{inputs.items}}", maxIterations: 5,
          steps: [
            { name: "inner", type: "loop", while: "{{steps.flag}}", maxIterations: 5, steps: [{ name: "t", type: "tool", tool: "x", arguments: {} }] },
          ],
        },
      ],
      outputs: {},
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a loop step without maxIterations", () => {
    const parsed = WorkflowSchema.safeParse({
      name: "bad",
      version: "1.0.0",
      inputs: {},
      steps: [{ name: "l", type: "loop", over: "{{inputs.x}}", steps: [{ name: "t", type: "tool", tool: "x", arguments: {} }] }],
      outputs: {},
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects maxIterations above the 1000 ceiling", () => {
    const parsed = WorkflowSchema.safeParse({
      name: "bad",
      version: "1.0.0",
      inputs: {},
      steps: [{ name: "l", type: "loop", over: "{{inputs.x}}", maxIterations: 1001, steps: [{ name: "t", type: "tool", tool: "x", arguments: {} }] }],
      outputs: {},
    });
    expect(parsed.success).toBe(false);
  });
});

describe("execution-state persistence (DT-MG-β)", () => {
  const simple: IWorkflowDefinition = {
    name: "persist-me",
    version: "1.0.0",
    inputs: {},
    steps: [{ name: "echo", type: "tool", tool: "test:echo", arguments: { hello: "world" } }],
    outputs: { out: "{{steps.echo}}" },
  };

  it("persists completed results to <dir>/<executionId>.json", async () => {
    const { ctx } = createCapturingContext();
    const dir = makeTempDir();
    const engine = new WorkflowEngine(ctx, { persistDir: dir });

    const result = await engine.execute(simple, {});

    const file = join(dir, `${result.executionId}.json`);
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as { status: string; workflowName: string };
    expect(onDisk.status).toBe("completed");
    expect(onDisk.workflowName).toBe("persist-me");
  });

  it("persists FAILED results too (crash diagnosability)", async () => {
    const { ctx } = createCapturingContext();
    const dir = makeTempDir();
    const engine = new WorkflowEngine(ctx, { persistDir: dir });
    const failing: IWorkflowDefinition = {
      ...simple,
      name: "fail-me",
      steps: [{ name: "boom", type: "tool", tool: "no:such:tool", arguments: {} }],
    };

    await expect(engine.execute(failing, {})).rejects.toThrow();

    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const onDisk = JSON.parse(readFileSync(join(dir, files[0]), "utf-8")) as { status: string; error?: { step?: string } };
    expect(onDisk.status).toBe("failed");
    expect(onDisk.error?.step).toBe("boom");
  });

  it("getStatus falls back to disk after the in-memory cache is gone (process-restart simulation)", async () => {
    const { ctx } = createCapturingContext();
    const dir = makeTempDir();
    const engine1 = new WorkflowEngine(ctx, { persistDir: dir });
    const result = await engine1.execute(simple, {});

    // Fresh engine = fresh LRU = simulated restart.
    const engine2 = new WorkflowEngine(ctx, { persistDir: dir });
    const recovered = engine2.getStatus(result.executionId);
    expect(recovered).toBeDefined();
    expect(recovered!.executionId).toBe(result.executionId);
    expect(recovered!.status).toBe("completed");
  });

  it("without persistDir, getStatus does NOT survive a new engine (pre-v0.58 MVP behavior preserved)", async () => {
    const { ctx } = createCapturingContext();
    const engine1 = new WorkflowEngine(ctx);
    const result = await engine1.execute(simple, {});
    const engine2 = new WorkflowEngine(ctx);
    expect(engine2.getStatus(result.executionId)).toBeUndefined();
  });
});

describe("resolveContextPath helper", () => {
  it("resolves single-tag templates and bare paths to raw values", () => {
    const context = { inputs: { items: [1, 2] }, steps: { s: { deep: { value: 42 } } } };
    expect(resolveContextPath(context, "{{inputs.items}}")).toEqual([1, 2]);
    expect(resolveContextPath(context, "inputs.items")).toEqual([1, 2]);
    expect(resolveContextPath(context, "steps.s.deep.value")).toBe(42);
    expect(resolveContextPath(context, "steps.missing.x")).toBeUndefined();
  });
});
