/**
 * REAL-process e2e for standard-function-exec. No mock of the thing under test:
 * an allowlisted command actually spawns a child via execFile and returns its stdout;
 * a blocked compound invocation is rejected BEFORE any spawn and emits tool:blocked.
 *
 * Uses `node` as the portable allowlisted executable so the assertion is identical on
 * Windows and POSIX (node is on PATH in CI). The block test asserts the guard verdict
 * + audit event only (no real spawn, no file side effect).
 */

import { describe, it, expect, vi } from "vitest";
import type { IPluginContext, ITool, ToolContext } from "@openstarry/sdk";
import { SecurityError } from "@openstarry/sdk";
import createExecPlugin from "./index.js";

function ctx(emit = vi.fn()): ToolContext {
  return {
    workingDirectory: process.cwd(),
    allowedPaths: [process.cwd()],
    bus: { emit, on: vi.fn(), once: vi.fn(), onAny: vi.fn() },
  } as unknown as ToolContext;
}

async function execTool(opts: Parameters<typeof createExecPlugin>[0]): Promise<ITool<any>> {
  const hooks = await createExecPlugin(opts).factory({ config: {} } as unknown as IPluginContext);
  return (hooks.tools as ITool<any>[]).find((t) => t.id === "exec.run")!;
}

describe("standard-function-exec e2e (real child process)", () => {
  it("runs an allowlisted command for real and returns its stdout", async () => {
    const tool = await execTool({ allowShell: true, allowedCommands: ["node"] });
    const out = await tool.execute(
      { command: "node", args: ["-e", "process.stdout.write('hi-from-child')"] },
      ctx(),
    );
    expect(out).toContain("hi-from-child");
  }, 20000);

  it("blocks a compound 'cat /etc/passwd && rm x' before spawning, with a tool:blocked event", async () => {
    const emit = vi.fn();
    const tool = await execTool({ allowShell: true, allowedCommands: ["cat"] });
    await expect(
      tool.execute({ command: "cat", args: ["/etc/passwd", "&&", "rm", "x"] }, ctx(emit)),
    ).rejects.toBeInstanceOf(SecurityError);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool:blocked" }),
    );
  });

  it("denies an allowlisted command when allowShell is off (default posture)", async () => {
    const tool = await execTool({ allowShell: false, allowedCommands: ["node"] });
    await expect(
      tool.execute({ command: "node", args: ["-e", "0"] }, ctx()),
    ).rejects.toBeInstanceOf(SecurityError);
  });
});
