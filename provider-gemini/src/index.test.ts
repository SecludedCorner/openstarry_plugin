/**
 * provider-gemini — Unit tests.
 */

import { describe, it, expect } from "vitest";
import { createGeminiPlugin } from "./index.js";

describe("provider-gemini", () => {
  it("exports createGeminiPlugin factory", () => {
    expect(createGeminiPlugin).toBeDefined();
    expect(typeof createGeminiPlugin).toBe("function");
  });

  it("returns IPlugin with manifest", () => {
    const plugin = createGeminiPlugin();
    expect(plugin.manifest).toBeDefined();
    expect(plugin.manifest.name).toBe("@openstarry-plugin/provider-gemini");
    expect(plugin.manifest.version).toBe("0.1.0-alpha");
  });

  it("has factory function", () => {
    const plugin = createGeminiPlugin();
    expect(plugin.factory).toBeDefined();
    expect(typeof plugin.factory).toBe("function");
  });
});
