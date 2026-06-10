import { describe, it, expect } from "vitest";
import { withTimeout, decrementTimeout } from "../src/timeout.js";

describe("L5 Timeout Hierarchy (Plan38 C10)", () => {
  it("resolves within timeout", async () => {
    const result = await withTimeout(async () => 42, 1000);
    expect(result).toBe(42);
  });

  it("throws TIMEOUT error when operation exceeds timeout", async () => {
    await expect(
      withTimeout(
        () => new Promise<void>(resolve => setTimeout(resolve, 500)),
        50,
      ),
    ).rejects.toThrow(/timed out/);
  });

  it("propagates inner errors (not timeout)", async () => {
    await expect(
      withTimeout(async () => { throw new Error("inner fail"); }, 1000),
    ).rejects.toThrow("inner fail");
  });

  it("decrementTimeout subtracts overhead", () => {
    expect(decrementTimeout(30000, 1000)).toBe(29000);
    expect(decrementTimeout(500, 1000)).toBe(0); // floor at 0
    expect(decrementTimeout(1000, 1000)).toBe(0);
  });

  it("decrementTimeout defaults to 1000ms overhead", () => {
    expect(decrementTimeout(5000)).toBe(4000);
  });
});
