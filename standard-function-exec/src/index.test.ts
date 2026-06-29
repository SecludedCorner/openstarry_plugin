/**
 * Unit tests for standard-function-exec — pure policy evaluation + tool block/emit path.
 * No real child process here (that is e2e.test.ts); the blocked path returns BEFORE
 * any spawn, so these are fast and deterministic.
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, ITool, ToolContext } from "@openstarry/sdk";
import { SecurityError } from "@openstarry/sdk";
import createExecPlugin from "./index.js";
import {
  DEFAULT_EXEC_GUARD_POLICY,
  resolvePolicy,
  evaluate,
  hasConnectorInjection,
} from "./policy.js";

function fakeCtx(emit = vi.fn()): ToolContext {
  return {
    workingDirectory: ".",
    allowedPaths: ["."],
    bus: { emit, on: vi.fn(), once: vi.fn(), onAny: vi.fn() },
  } as unknown as ToolContext;
}

async function execTool(opts: Parameters<typeof createExecPlugin>[0]): Promise<ITool<any>> {
  const hooks = await createExecPlugin(opts).factory({ config: {} } as unknown as IPluginContext);
  return (hooks.tools as ITool<any>[]).find((t) => t.id === "exec.run")!;
}

describe("evaluate (pure policy)", () => {
  it("DEFAULT policy denies everything (allowShell:false)", () => {
    expect(evaluate("echo", ["hi"], DEFAULT_EXEC_GUARD_POLICY)).toEqual({
      ok: false,
      reason: "command execution disabled (allowShell=false)",
    });
  });

  it("allows an allowlisted command when allowShell is on", () => {
    const p = resolvePolicy({ allowShell: true, allowedCommands: ["echo"] });
    expect(evaluate("echo", ["hello"], p)).toEqual({ ok: true });
  });

  it("rejects a command not in the allowlist", () => {
    const p = resolvePolicy({ allowShell: true, allowedCommands: ["echo"] });
    expect(evaluate("cat", ["x"], p)).toMatchObject({ ok: false });
  });

  it("rejects shell-control connectors in an argument", () => {
    const p = resolvePolicy({ allowShell: true, allowedCommands: ["echo"] });
    expect(evaluate("echo", ["a&&b"], p)).toMatchObject({ ok: false });
    expect(evaluate("echo", ["$(whoami)"], p)).toMatchObject({ ok: false });
    expect(evaluate("echo", ["a;b"], p)).toMatchObject({ ok: false });
  });

  it("rejects denylisted command lines (defense-in-depth)", () => {
    const p = resolvePolicy({ allowShell: true, allowedCommands: ["rm"] });
    expect(evaluate("rm", ["-rf", "/"], p)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("denylist"),
    });
  });

  it("rejects too many args", () => {
    const p = resolvePolicy({ allowShell: true, allowedCommands: ["echo"], maxArgs: 2 });
    expect(evaluate("echo", ["a", "b", "c"], p)).toMatchObject({ ok: false });
  });

  it("is pure: same input → same output", () => {
    const p = resolvePolicy({ allowShell: true, allowedCommands: ["echo"] });
    expect(evaluate("echo", ["x"], p)).toEqual(evaluate("echo", ["x"], p));
  });

  it("hasConnectorInjection flags metacharacters but not plain text", () => {
    expect(hasConnectorInjection("plainArg")).toBe(false);
    expect(hasConnectorInjection("a | b")).toBe(true);
    expect(hasConnectorInjection("`id`")).toBe(true);
  });
});

describe("exec.run tool wiring", () => {
  it("exposes a single samskara tool requiring confirmation", async () => {
    const tool = await execTool({ allowShell: true, allowedCommands: ["echo"] });
    expect(tool.id).toBe("exec.run");
    expect(tool.skandha).toBe("samskara");
    expect(tool.metadata?.requiresConfirmation).toBe(true);
    expect(tool.metadata?.riskCategory).toBe("destructive");
  });

  it("throws SecurityError AND emits tool:blocked on a blocked invocation", async () => {
    const emit = vi.fn();
    const tool = await execTool({ allowShell: true, allowedCommands: ["echo"] });
    await expect(
      tool.execute({ command: "cat", args: ["/etc/passwd", "&&", "rm", "x"] }, fakeCtx(emit)),
    ).rejects.toBeInstanceOf(SecurityError);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool:blocked",
        payload: expect.objectContaining({ name: "exec.run" }),
      }),
    );
  });

  it("default plugin (no opts) denies all — no emit-less silent pass", async () => {
    const emit = vi.fn();
    const tool = await execTool(undefined);
    await expect(
      tool.execute({ command: "echo", args: ["hi"] }, fakeCtx(emit)),
    ).rejects.toBeInstanceOf(SecurityError);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
