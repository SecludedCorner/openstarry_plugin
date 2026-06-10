import { describe, it, expect } from "vitest";
import { Bulkhead } from "../src/bulkhead.js";
import { BulkheadRejectError } from "@openstarry/sdk";

describe("L3 Bulkhead (Plan38 C10)", () => {
  it("allows requests up to maxConcurrent", async () => {
    const bh = new Bulkhead({ maxConcurrent: 2, maxQueue: 0 });
    await bh.acquire("t");
    await bh.acquire("t");
    expect(bh.getActive("t")).toBe(2);
  });

  it("throws BulkheadRejectError when pool and queue are full", async () => {
    const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 0 });
    await bh.acquire("t");
    await expect(bh.acquire("t")).rejects.toThrow(BulkheadRejectError);
  });

  it("queues requests when pool is full but queue has space", async () => {
    const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    await bh.acquire("t");
    const queued = bh.acquire("t"); // Should queue, not reject
    expect(bh.getQueueLength("t")).toBe(1);
    bh.release("t"); // Release first slot, dequeue second
    await queued;
    expect(bh.getActive("t")).toBe(1);
  });

  it("releases correctly and dequeues next waiter", async () => {
    const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 2 });
    await bh.acquire("t");
    const p1 = bh.acquire("t");
    const p2 = bh.acquire("t");
    bh.release("t");
    await p1;
    bh.release("t");
    await p2;
    expect(bh.getActive("t")).toBe(1);
    bh.release("t");
    expect(bh.getActive("t")).toBe(0);
  });

  it("per-target isolation: different targets have independent pools", async () => {
    const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 0 });
    await bh.acquire("t1");
    await bh.acquire("t2"); // Different target, should work
    expect(bh.getActive("t1")).toBe(1);
    expect(bh.getActive("t2")).toBe(1);
  });

  it("removeTarget rejects queued waiters", async () => {
    const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    await bh.acquire("t");
    const queued = bh.acquire("t");
    bh.removeTarget("t");
    await expect(queued).rejects.toThrow(/removed/);
  });
});
