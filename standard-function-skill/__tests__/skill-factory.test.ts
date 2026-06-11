/**
 * DT-42-C (cycle 03-43) — standard-function-skill cell-specific test coverage.
 *
 * Per cycle 03-42 R1 §D §13 reconciliation: closes FIX-CY40-skill-factory-test
 * INFO LOW finding (cycle 03-39 §A1.3-06 test coverage gap; 2-cycle dormancy
 * at cycle 03-41 close).
 *
 * Covers:
 *   - parseSkillFile: YAML frontmatter happy path
 *   - parseSkillFile: missing/malformed frontmatter fallback
 *   - createSkillPlugin: factory shape + manifest fields
 *   - factory: empty hooks when no skillPath configured
 */

import { describe, expect, it, vi } from "vitest";
import { createSkillPlugin, parseSkillFile } from "../src/index.js";

describe("standard-function-skill — parseSkillFile (DT-42-C)", () => {
  it("parses YAML frontmatter and Markdown body", () => {
    const { frontmatter, body } = parseSkillFile(
      "---\nid: my-skill\ndescription: A test skill\n---\n\nBody text.",
    );
    expect(frontmatter.id).toBe("my-skill");
    expect(frontmatter.description).toBe("A test skill");
    expect(body).toBe("Body text.");
  });

  it("falls back to unnamed-skill when no frontmatter delimiter present", () => {
    const { frontmatter, body } = parseSkillFile("Just body content without frontmatter.");
    expect(frontmatter.id).toBe("unnamed-skill");
    expect(body).toBe("Just body content without frontmatter.");
  });

  it("falls back when frontmatter closing delimiter missing", () => {
    const { frontmatter, body } = parseSkillFile("---\nid: orphan\nno-closing-delimiter");
    expect(frontmatter.id).toBe("unnamed-skill");
    expect(body).toContain("orphan");
  });

  it("preserves dependencies and parameters sub-objects from YAML", () => {
    const yaml = `---
id: full-skill
dependencies:
  plugins: [provider-claude]
  capabilities: [tool_use]
parameters:
  temperature: 0.7
  model_preference: [claude-3-5-sonnet]
---

content`;
    const { frontmatter } = parseSkillFile(yaml);
    expect(frontmatter.dependencies?.plugins).toEqual(["provider-claude"]);
    expect(frontmatter.parameters?.temperature).toBe(0.7);
  });
});

describe("standard-function-skill — createSkillPlugin factory (DT-42-C)", () => {
  it("returns plugin with correct manifest shape", () => {
    const plugin = createSkillPlugin();
    expect(plugin.manifest.name).toBe("standard-function-skill");
    expect(plugin.manifest.skandha).toEqual(["samskara", "vijnana"]);
    expect(typeof plugin.factory).toBe("function");
  });

  it("returns empty hooks when no skillPath configured", async () => {
    const plugin = createSkillPlugin();
    const ctx = {
      config: {},
      workingDirectory: "/tmp",
      pushInput: vi.fn(),
    } as unknown as Parameters<typeof plugin.factory>[0];
    const hooks = await plugin.factory(ctx);
    expect(hooks).toEqual({});
  });
});
