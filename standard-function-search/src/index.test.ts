/**
 * Tests for standard-function-search — code.search (grep) + code.glob, against a real
 * temp directory tree (no mocks of fs). Covers substring/regex/ignoreCase/glob filtering,
 * node_modules skipping, the realpath jail, and no-match output.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import type { ITool, ToolContext } from "@openstarry/sdk";
import { SecurityError } from "@openstarry/sdk";
import createSearchPlugin from "./index.js";

function toolMap(tools: ITool<unknown>[]): Record<string, ITool<any>> {
  return Object.fromEntries(tools.map((t) => [t.id, t]));
}

describe("standard-function-search", () => {
  let dir: string;
  let outside: string;
  let tools: Record<string, ITool<any>>;
  let ctx: ToolContext;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "search-"));
    outside = mkdtempSync(join(tmpdir(), "search-outside-"));
    writeFileSync(join(dir, "a.ts"), "export function foo() {\n  return 42;\n}\n");
    writeFileSync(join(dir, "b.js"), "const bar = 'FOO bar';\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "c.ts"), "import { foo } from '../a';\n// TODO: fix\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "junk.ts"), "function foo() {} // should be skipped\n");
    writeFileSync(join(outside, "secret.ts"), "function foo() { return 'secret'; }\n");

    const hooks = await createSearchPlugin().factory({} as never);
    tools = toolMap(hooks.tools as ITool<unknown>[]);
    ctx = { workingDirectory: dir, allowedPaths: [dir] } as ToolContext;
  });

  afterEach(() => {
    for (const d of [dir, outside]) {
      try { if (existsSync(d)) rmSync(d, { recursive: true, force: true }); } catch { /* win32 */ }
    }
  });

  it("exposes code.search and code.glob (samskara, read-only)", () => {
    expect(Object.keys(tools).sort()).toEqual(["code.glob", "code.search"]);
    for (const t of Object.values(tools)) {
      expect(t.skandha).toBe("samskara");
      expect(t.metadata?.riskCategory).toBe("safe");
    }
  });

  it("code.search finds a substring across files with file:line output", async () => {
    const out: string = await tools["code.search"].execute({ query: "function foo" }, ctx);
    expect(out).toContain("a.ts:1:");
    expect(out).toContain("function foo");
  });

  it("code.search skips node_modules", async () => {
    const out: string = await tools["code.search"].execute({ query: "should be skipped" }, ctx);
    expect(out).toBe("(no matches)");
  });

  it("code.search honors ignoreCase and regex", async () => {
    const ci: string = await tools["code.search"].execute({ query: "foo", ignoreCase: true }, ctx);
    expect(ci).toContain("b.js"); // matches 'FOO' case-insensitively
    const rx: string = await tools["code.search"].execute({ query: "return\\s+\\d+", regex: true }, ctx);
    expect(rx).toContain("a.ts");
  });

  it("code.search glob filters to matching files", async () => {
    const tsOnly: string = await tools["code.search"].execute({ query: "foo", glob: "*.ts" }, ctx);
    expect(tsOnly).toContain("a.ts");
    expect(tsOnly).not.toContain("b.js");
  });

  it("code.glob finds files by pattern (and **/ recursion)", async () => {
    const all: string = await tools["code.glob"].execute({ pattern: "**/*.ts" }, ctx);
    expect(all).toContain("a.ts");
    expect(all).toContain("src/c.ts");
    expect(all).not.toContain("node_modules");
  });

  it("SECURITY: searching outside allowedPaths throws SecurityError", async () => {
    await expect(
      tools["code.search"].execute({ query: "secret", path: outside }, ctx),
    ).rejects.toBeInstanceOf(SecurityError);
  });

  it("returns a friendly message on no match", async () => {
    const out: string = await tools["code.search"].execute({ query: "zzz_nonexistent_zzz" }, ctx);
    expect(out).toBe("(no matches)");
  });
});
