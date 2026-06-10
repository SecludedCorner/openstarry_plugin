import { describe, it, expect } from "vitest";
import { createChatGptOAuthPlugin } from "../src/index.js";

describe("provider-chatgpt-oauth smoke test", () => {
  it("createChatGptOAuthPlugin is a function", () => {
    expect(typeof createChatGptOAuthPlugin).toBe("function");
  });

  it("factory returns an object with a manifest", () => {
    const plugin = createChatGptOAuthPlugin();
    expect(plugin).toBeDefined();
    expect(typeof plugin.manifest).toBe("object");
  });

  it("manifest has required fields", () => {
    const plugin = createChatGptOAuthPlugin();
    const { manifest } = plugin;
    expect(manifest.name).toBe("@openstarry-plugin/provider-chatgpt-oauth");
    expect(typeof manifest.version).toBe("string");
    expect(manifest.skandha).toBe("samjna");
  });

  it("manifest.criticality is a valid value", () => {
    const plugin = createChatGptOAuthPlugin();
    const validCriticalities = ["required", "optional-degraded", "optional"];
    expect(validCriticalities).toContain(plugin.manifest.criticality);
  });

  it("plugin has a factory function", () => {
    const plugin = createChatGptOAuthPlugin();
    expect(typeof plugin.factory).toBe("function");
  });
});
