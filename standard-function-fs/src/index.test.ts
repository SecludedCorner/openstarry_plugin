/**
 * Tests for standard-function-fs — the filesystem ITool plugin (samskara).
 * Shipped with zero test coverage (v0.59.7 audit). Focus: the path-validation
 * SECURITY boundary (reject outside allowedPaths) + a real read/write/list/
 * mkdir/delete round-trip in a temp sandbox.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import type { ITool, ToolContext } from "@openstarry/sdk";
import { SecurityError } from "@openstarry/sdk";
import createFsPlugin from "./index.js";

function toolMap(tools: ITool<unknown>[]): Record<string, ITool<any>> {
  return Object.fromEntries(tools.map((t) => [t.id, t]));
}

describe("standard-function-fs", () => {
  let sandbox: string;
  let tools: Record<string, ITool<any>>;
  let ctx: ToolContext;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "fs-plugin-test-"));
    const plugin = createFsPlugin();
    const hooks = await plugin.factory({} as never);
    tools = toolMap(hooks.tools as ITool<unknown>[]);
    ctx = { workingDirectory: sandbox, allowedPaths: [sandbox] } as ToolContext;
  });

  afterEach(() => {
    if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
  });

  it("exposes the 5 fs tools", () => {
    expect(Object.keys(tools).sort()).toEqual(
      ["fs.delete", "fs.list", "fs.mkdir", "fs.read", "fs.write"].sort(),
    );
    for (const t of Object.values(tools)) expect(t.skandha).toBe("samskara");
  });

  it("write → read round-trip within the sandbox", async () => {
    await tools["fs.write"].execute({ path: "hello.txt", content: "hi there" }, ctx);
    const content = await tools["fs.read"].execute({ path: "hello.txt" }, ctx);
    expect(content).toBe("hi there");
  });

  it("mkdir + list reflects created entries", async () => {
    await tools["fs.mkdir"].execute({ path: "sub" }, ctx);
    await tools["fs.write"].execute({ path: "sub/a.txt", content: "x" }, ctx);
    const listing = await tools["fs.list"].execute({ path: "sub" }, ctx);
    expect(listing).toContain("a.txt");
  });

  it("delete removes a file", async () => {
    await tools["fs.write"].execute({ path: "gone.txt", content: "x" }, ctx);
    expect(existsSync(join(sandbox, "gone.txt"))).toBe(true);
    await tools["fs.delete"].execute({ path: "gone.txt" }, ctx);
    expect(existsSync(join(sandbox, "gone.txt"))).toBe(false);
  });

  it("SECURITY: rejects read outside allowedPaths with SecurityError", async () => {
    const outside = mkdtempSync(join(tmpdir(), "fs-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    try {
      await expect(
        tools["fs.read"].execute({ path: join(outside, "secret.txt") }, ctx),
      ).rejects.toBeInstanceOf(SecurityError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("SECURITY: rejects path-traversal escape (../) with SecurityError", async () => {
    await expect(
      tools["fs.write"].execute(
        { path: "../escape.txt", content: "nope" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(SecurityError);
  });

  it("SECURITY: rejects write outside allowedPaths", async () => {
    await expect(
      tools["fs.write"].execute(
        { path: join(tmpdir(), "elsewhere.txt"), content: "nope" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(SecurityError);
  });
});
