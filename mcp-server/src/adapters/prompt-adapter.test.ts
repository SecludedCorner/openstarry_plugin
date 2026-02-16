import { describe, it, expect, vi } from "vitest";
import { guideToMcpDefinition, getPromptForMcp } from "./prompt-adapter.js";
import type { IGuide } from "@openstarry/sdk";

function makeMockGuide(overrides: Partial<IGuide> = {}): IGuide {
  return {
    id: "test-guide",
    name: "Test Guide",
    getSystemPrompt: vi.fn().mockReturnValue("You are a helpful assistant."),
    ...overrides,
  };
}

describe("guideToMcpDefinition", () => {
  it("converts IGuide to MCP prompt definition", () => {
    const guide = makeMockGuide();
    const result = guideToMcpDefinition(guide);

    expect(result.name).toBe("test-guide");
    expect(result.description).toBe("Test Guide");
    expect(result.arguments).toEqual([]);
  });

  it("preserves guide name as description", () => {
    const guide = makeMockGuide({ name: "Custom Persona" });
    const result = guideToMcpDefinition(guide);
    expect(result.description).toBe("Custom Persona");
  });
});

describe("getPromptForMcp", () => {
  it("returns system prompt as user message", async () => {
    const guide = makeMockGuide();
    const result = await getPromptForMcp(guide);

    expect(result.description).toBe("Test Guide");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toEqual({
      type: "text",
      text: "You are a helpful assistant.",
    });
  });

  it("handles async getSystemPrompt", async () => {
    const guide = makeMockGuide({
      getSystemPrompt: vi.fn().mockResolvedValue("Async prompt content"),
    });
    const result = await getPromptForMcp(guide);

    expect(result.messages[0].content).toEqual({
      type: "text",
      text: "Async prompt content",
    });
  });
});
