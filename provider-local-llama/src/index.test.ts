/**
 * provider-local-llama — Unit tests.
 */

import { describe, it, expect } from "vitest";
import { createLocalLlamaPlugin } from "./index.js";

describe("provider-local-llama", () => {
  it("exports createLocalLlamaPlugin factory", () => {
    expect(createLocalLlamaPlugin).toBeDefined();
    expect(typeof createLocalLlamaPlugin).toBe("function");
  });

  it("returns IPlugin with manifest", () => {
    const plugin = createLocalLlamaPlugin();
    expect(plugin.manifest).toBeDefined();
    expect(plugin.manifest.name).toBe("@openstarry-plugin/provider-local-llama");
    expect(plugin.manifest.version).toBe("0.1.0-alpha");
  });

  it("has factory function", () => {
    const plugin = createLocalLlamaPlugin();
    expect(plugin.factory).toBeDefined();
    expect(typeof plugin.factory).toBe("function");
  });
});
