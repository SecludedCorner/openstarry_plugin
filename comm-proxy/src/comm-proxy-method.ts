/**
 * CommProxyMethod — Template Method base class for comm proxy operations.
 * Plan39 W2 (D3-R3, CONSTRAINT-D14).
 *
 * Pattern: preExecute → execute → postExecute (or onError on throw).
 * Subclasses override execute() (required) and optionally preExecute(),
 * postExecute(), onError() for tracing, metrics, and error normalization.
 *
 * Split bulkhead: fire-and-forget and rpc lanes are independently tracked
 * so a saturated send lane cannot block a call lane (AC-W2-2).
 */

import type {
  BulkheadType,
  CommMethodResult,
  CommProxyError,
  ICommProxyMethod,
} from '@openstarry/sdk';
import { BulkheadRejectError, CircuitBreakerError } from '@openstarry/sdk';

// ---------------------------------------------------------------------------
// Split Bulkhead
// ---------------------------------------------------------------------------

/**
 * SplitBulkhead maintains two independent concurrency pools:
 * - 'fire-and-forget': for send and publish operations
 * - 'rpc': for call and reply operations
 *
 * Each lane counts independently so saturation in one lane
 * does not affect the other (AC-W2-2).
 */
export class SplitBulkhead {
  private readonly pools = new Map<BulkheadType, number>([
    ['fire-and-forget', 0],
    ['rpc', 0],
  ]);
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = 32) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Increment the lane counter. Throws CommProxyError if lane is full. */
  acquire(lane: BulkheadType): void {
    const current = this.pools.get(lane)!;
    if (current >= this.maxConcurrent) {
      const err: CommProxyError = {
        code: 'BULKHEAD_FULL',
        message: `Bulkhead lane "${lane}" is full (${current}/${this.maxConcurrent})`,
      };
      throw err;
    }
    this.pools.set(lane, current + 1);
  }

  /** Decrement the lane counter. */
  release(lane: BulkheadType): void {
    const current = this.pools.get(lane)!;
    this.pools.set(lane, Math.max(0, current - 1));
  }

  /** Current active count for a lane. */
  getActive(lane: BulkheadType): number {
    return this.pools.get(lane) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// CommProxyMethod abstract base class
// ---------------------------------------------------------------------------

/**
 * Abstract base class implementing ICommProxyMethod<TArgs, TResult>.
 * Subclasses provide execute() and declare their bulkheadType.
 *
 * Template flow inside run():
 *   1. preExecute(args)   — validation, tracing setup (hook)
 *   2. execute(args)      — channel operation (abstract)
 *   3. postExecute(result)— cleanup, metrics (hook)
 *   on throw: onError(error) — error normalization (hook)
 */
export abstract class CommProxyMethod<TArgs, TResult>
  implements ICommProxyMethod<TArgs, TResult>
{
  abstract readonly bulkheadType: BulkheadType;

  /** Hook: validation and tracing setup before execute. Override as needed. */
  protected preExecute(_args: TArgs): void {
    // Default: no-op
  }

  /** Abstract: the actual channel operation. Must be implemented by subclasses. */
  protected abstract execute(args: TArgs): Promise<TResult>;

  /** Hook: cleanup and metrics after a successful execute. Override as needed. */
  protected postExecute(_result: TResult): void {
    // Default: no-op
  }

  /**
   * Hook: error normalization. Override to map domain-specific errors.
   * Default: maps BulkheadRejectError → BULKHEAD_FULL,
   *          CircuitBreakerError → CIRCUIT_OPEN,
   *          timeout errors → TIMEOUT,
   *          everything else → CHANNEL_ERROR or UNKNOWN.
   */
  protected onError(error: unknown): CommProxyError {
    if (error && typeof error === 'object' && 'code' in error) {
      const coded = error as { code: string; message?: string };
      if (coded.code === 'BULKHEAD_FULL' || coded.code === 'TIMEOUT' ||
          coded.code === 'CIRCUIT_OPEN' || coded.code === 'CHANNEL_ERROR') {
        return {
          code: coded.code as CommProxyError['code'],
          message: coded.message ?? String(error),
          originalError: error,
        };
      }
    }
    if (error instanceof BulkheadRejectError) {
      return { code: 'BULKHEAD_FULL', message: error.message, originalError: error };
    }
    if (error instanceof CircuitBreakerError) {
      return { code: 'CIRCUIT_OPEN', message: error.message, originalError: error };
    }
    if (error instanceof Error && error.message.includes('timed out')) {
      return { code: 'TIMEOUT', message: error.message, originalError: error };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { code: 'CHANNEL_ERROR', message: msg, originalError: error };
  }

  /**
   * Execute the full template: preExecute → execute → postExecute (or onError).
   * The proxy calls this; never call execute() directly.
   */
  async run(args: TArgs): Promise<CommMethodResult<TResult>> {
    try {
      this.preExecute(args);
      const result = await this.execute(args);
      this.postExecute(result);
      return { success: true, value: result };
    } catch (err) {
      const normalized = this.onError(err);
      return { success: false, error: normalized };
    }
  }
}
