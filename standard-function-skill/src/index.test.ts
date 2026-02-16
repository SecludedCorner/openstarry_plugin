import { describe, it, expect } from "vitest";
import { parseSkillFile } from "./index.js";

describe("parseSkillFile", () => {
  it("parses valid frontmatter and body", () => {
    const content = `---
type: "skill"
id: "test-coder"
version: "1.0.0"
description: "A test skill"
---

# Role
You are a test assistant.

# Constraints
1. Be helpful.
`;

    const result = parseSkillFile(content);

    expect(result.frontmatter.type).toBe("skill");
    expect(result.frontmatter.id).toBe("test-coder");
    expect(result.frontmatter.version).toBe("1.0.0");
    expect(result.frontmatter.description).toBe("A test skill");
    expect(result.body).toContain("# Role");
    expect(result.body).toContain("You are a test assistant.");
    expect(result.body).toContain("# Constraints");
  });

  it("parses frontmatter with dependencies and parameters", () => {
    const content = `---
type: "skill"
id: "advanced-skill"
dependencies:
  plugins: ["standard/fs", "standard/mcp-server"]
  capabilities: ["read-file", "write-file"]
parameters:
  temperature: 0.2
  model_preference: ["gemini-2.0-flash", "gpt-4"]
---

Body content here.
`;

    const result = parseSkillFile(content);

    expect(result.frontmatter.id).toBe("advanced-skill");
    expect(result.frontmatter.dependencies?.plugins).toEqual([
      "standard/fs",
      "standard/mcp-server",
    ]);
    expect(result.frontmatter.dependencies?.capabilities).toEqual([
      "read-file",
      "write-file",
    ]);
    expect(result.frontmatter.parameters?.temperature).toBe(0.2);
    expect(result.frontmatter.parameters?.model_preference).toEqual([
      "gemini-2.0-flash",
      "gpt-4",
    ]);
    expect(result.body).toBe("Body content here.");
  });

  it("handles content without frontmatter", () => {
    const content = "# Just a plain markdown file\n\nNo frontmatter here.";

    const result = parseSkillFile(content);

    expect(result.frontmatter.id).toBe("unnamed-skill");
    expect(result.body).toContain("# Just a plain markdown file");
  });

  it("handles malformed frontmatter (unclosed ---)", () => {
    const content = "---\nid: broken\nThis never closes";

    const result = parseSkillFile(content);

    expect(result.frontmatter.id).toBe("unnamed-skill");
    expect(result.body).toContain("---");
  });

  it("handles empty body", () => {
    const content = `---
id: "empty-body"
---
`;

    const result = parseSkillFile(content);

    expect(result.frontmatter.id).toBe("empty-body");
    expect(result.body).toBe("");
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---

Some body content.
`;

    const result = parseSkillFile(content);

    expect(result.frontmatter.id).toBe("unnamed-skill");
    expect(result.body).toBe("Some body content.");
  });

  it("preserves markdown formatting in body", () => {
    const content = `---
id: "format-test"
---

## Section 1
- Item A
- Item B

\`\`\`typescript
const x = 1;
\`\`\`

> A blockquote
`;

    const result = parseSkillFile(content);

    expect(result.frontmatter.id).toBe("format-test");
    expect(result.body).toContain("## Section 1");
    expect(result.body).toContain("- Item A");
    expect(result.body).toContain("```typescript");
    expect(result.body).toContain("> A blockquote");
  });
});
