/**
 * L3 Bulkhead — per-target connection pool with overflow queue.
 * Plan38 C10.
 *
 * MECHANISM: Pool management is non-bypassable.
 * POLICY: maxConcurrent, maxQueue are SDK defaults.
 */

import type { BulkheadConfig } from "@openstarry/sdk";
import {
  DEFAULT_BULKHEAD_MAX_CONCURRENT,
  DEFAULT_BULKHEAD_MAX_QUEUE,
  BulkheadRejectError,
} from "@openstarry/sdk";

interface BulkheadEntry {
  active: number;
  queue: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

export class Bulkhead {
  private targets = new Map<string, BulkheadEntry>();
  private readonly config: Required<Pick<BulkheadConfig, 'maxConcurrent' | 'maxQueue'>>;

  constructor(config?: Partial<BulkheadConfig>) {
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? DEFAULT_BULKHEAD_MAX_CONCURRENT,
      maxQueue: config?.maxQueue ?? DEFAULT_BULKHEAD_MAX_QUEUE,
    };
  }

  private getOrCreate(targetId: string): BulkheadEntry {
    let entry = this.targets.get(targetId);
    if (!entry) {
      entry = { active: 0, queue: [] };
      this.targets.set(targetId, entry);
    }
    return entry;
  }

  /**
   * Acquire a slot for the target.
   * If pool is full, wait in queue. If queue is full, throw BulkheadRejectError.
   */
  async acquire(targetId: string): Promise<void> {
    const entry = this.getOrCreate(targetId);

    if (entry.active < this.config.maxConcurrent) {
      entry.active++;
      return;
    }

    // Pool full — queue the request
    if (entry.queue.length >= this.config.maxQueue) {
      throw new BulkheadRejectError(targetId, entry.active, this.config.maxConcurrent);
    }

    return new Promise<void>((resolve, reject) => {
      entry.queue.push({ resolve, reject });
    });
  }

  /** Release a slot for the target. Dequeues next waiter if any. */
  release(targetId: string): void {
    const entry = this.targets.get(targetId);
    if (!entry) return;

    entry.active--;

    if (entry.queue.length > 0 && entry.active < this.config.maxConcurrent) {
      const next = entry.queue.shift()!;
      entry.active++;
      next.resolve();
    }
  }

  /** Get current active count for a target. */
  getActive(targetId: string): number {
    return this.targets.get(targetId)?.active ?? 0;
  }

  /** Get current queue length for a target. */
  getQueueLength(targetId: string): number {
    return this.targets.get(targetId)?.queue.length ?? 0;
  }

  /** Remove a target (cleanup on deregister). */
  removeTarget(targetId: string): void {
    const entry = this.targets.get(targetId);
    if (entry) {
      for (const waiter of entry.queue) {
        waiter.reject(new Error(`Target "${targetId}" removed`));
      }
      this.targets.delete(targetId);
    }
  }
}
