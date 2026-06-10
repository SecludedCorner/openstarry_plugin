/**
 * L5 Timeout Hierarchy — outer > sum(inner) + overhead.
 * Plan38 C10.
 *
 * MECHANISM: Timeout invariant is non-bypassable.
 * POLICY: DEFAULT_MESSAGE_TIMEOUT_MS is SDK default.
 */

import { DEFAULT_MESSAGE_TIMEOUT_MS } from "@openstarry/sdk";

/**
 * Wrap an async operation with a timeout.
 * Uses AbortController for clean cancellation.
 *
 * @param operation - The async function to execute.
 * @param timeoutMs - Timeout in milliseconds. Defaults to DEFAULT_MESSAGE_TIMEOUT_MS.
 * @returns The result of the operation.
 * @throws Error with "TIMEOUT" code if operation exceeds timeout.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = DEFAULT_MESSAGE_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`Operation timed out after ${timeoutMs}ms`);
      (error as Error & { code: string }).code = 'TIMEOUT';
      reject(error);
    }, timeoutMs);

    operation(controller.signal).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Propagate timeout decrement to child operations.
 * Ensures outer > sum(inner) + overhead invariant.
 *
 * @param parentTimeoutMs - Parent's remaining timeout.
 * @param overheadMs - Reserved overhead for processing.
 * @returns Adjusted timeout for child operation, or 0 if exhausted.
 */
export function decrementTimeout(
  parentTimeoutMs: number,
  overheadMs: number = 1000,
): number {
  const remaining = parentTimeoutMs - overheadMs;
  return Math.max(0, remaining);
}
