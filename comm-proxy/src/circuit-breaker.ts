/**
 * L2 Circuit Breaker — per-target state machine.
 * Plan38 C10.
 *
 * MECHANISM: State transitions (CLOSED→OPEN→HALF_OPEN) are non-bypassable.
 * POLICY: failureThreshold, cooldownMs, monitorWindowMs are SDK defaults.
 */

import type { CircuitBreakerState, CircuitBreakerConfig } from "@openstarry/sdk";
import {
  DEFAULT_CB_FAILURE_THRESHOLD,
  DEFAULT_CB_COOLDOWN_MS,
  DEFAULT_CB_MONITOR_WINDOW_MS,
  CircuitBreakerError,
} from "@openstarry/sdk";

interface CBEntry {
  state: CircuitBreakerState;
  failures: number[];  // timestamps of failures within window
  lastOpenedAt: number;
}

export class CircuitBreaker {
  private targets = new Map<string, CBEntry>();
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? DEFAULT_CB_FAILURE_THRESHOLD,
      cooldownMs: config?.cooldownMs ?? DEFAULT_CB_COOLDOWN_MS,
      monitorWindowMs: config?.monitorWindowMs ?? DEFAULT_CB_MONITOR_WINDOW_MS,
    };
  }

  private getOrCreate(targetId: string): CBEntry {
    let entry = this.targets.get(targetId);
    if (!entry) {
      entry = { state: 'CLOSED', failures: [], lastOpenedAt: 0 };
      this.targets.set(targetId, entry);
    }
    return entry;
  }

  /**
   * Check if a request to the target is allowed.
   * @throws CircuitBreakerError if circuit is OPEN.
   */
  check(targetId: string): void {
    const entry = this.getOrCreate(targetId);
    const now = Date.now();

    if (entry.state === 'OPEN') {
      // Check if cooldown has elapsed → transition to HALF_OPEN
      if (now - entry.lastOpenedAt >= this.config.cooldownMs) {
        entry.state = 'HALF_OPEN';
        // Allow one probe request
        return;
      }
      throw new CircuitBreakerError(targetId, 'OPEN');
    }

    // CLOSED and HALF_OPEN allow requests
  }

  /** Record a successful send to the target. */
  recordSuccess(targetId: string): void {
    const entry = this.getOrCreate(targetId);
    if (entry.state === 'HALF_OPEN') {
      entry.state = 'CLOSED';
      entry.failures = [];
    }
  }

  /** Record a failed send to the target. */
  recordFailure(targetId: string): void {
    const entry = this.getOrCreate(targetId);
    const now = Date.now();

    if (entry.state === 'HALF_OPEN') {
      // Probe failed — back to OPEN
      entry.state = 'OPEN';
      entry.lastOpenedAt = now;
      return;
    }

    // Sliding window: remove expired failures
    const cutoff = now - this.config.monitorWindowMs;
    entry.failures = entry.failures.filter(t => t > cutoff);
    entry.failures.push(now);

    if (entry.failures.length >= this.config.failureThreshold) {
      entry.state = 'OPEN';
      entry.lastOpenedAt = now;
    }
  }

  /** Get current state for a target. */
  getState(targetId: string): CircuitBreakerState {
    return this.getOrCreate(targetId).state;
  }

  /** Reset a target's circuit breaker. */
  reset(targetId: string): void {
    this.targets.delete(targetId);
  }
}
