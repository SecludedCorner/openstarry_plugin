/**
 * DefaultLoopQualityMonitor — loop quality monitor.
 *
 * Implements ILoopQualityMonitor with a 4-dimensional quality formula:
 * - coherence: 1 - switchCount / (W - 1)
 * - efficiency: successCount / proposedCount (or 1.0)
 * - convergence: longestStreak / W
 * - stability: 1 - min(1, σ² / 0.25) using Welford's online algorithm
 *
 * Sliding window W=10, warmup=5.
 * Subscribes to MINIMAL_QUALITY_EVENTS (6 events).
 *
 * @skandha vijnana (識蘊)
 * @see Plan30 Wave 1, Plan32 Wave 2 (extracted to plugin)
 */

import type {
  ILoopQualityMonitor,
  LoopQualityReport,
  LoopQualityVector,
  EventBus,
  EventHandler,
  AgentEvent,
} from "@openstarry/sdk";
import { DEFAULT_LOOP_QUALITY_WEIGHTS } from "@openstarry/sdk";

export interface DefaultMonitorConfig {
  readonly windowSize?: number;
  readonly warmupCount?: number;
}

const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_WARMUP_COUNT = 5;
/** Per-cycle arbiter confidence cap to prevent unbounded growth (SEC-030-04) */
const MAX_ARBITER_CONFIDENCES_PER_CYCLE = 100;

export function createDefaultLoopQualityMonitor(
  config?: DefaultMonitorConfig,
): ILoopQualityMonitor {
  const W = config?.windowSize ?? DEFAULT_WINDOW_SIZE;
  const warmup = config?.warmupCount ?? DEFAULT_WARMUP_COUNT;
  const weights = DEFAULT_LOOP_QUALITY_WEIGHTS;

  let cycleGearSwitchCount = 0;
  let cycleProposedCount = 0;
  let cycleSuccessCount = 0;
  let cycleArbiterConfidences: number[] = [];

  const windowSwitches: number[] = [];
  const windowProposed: number[] = [];
  const windowSuccesses: number[] = [];
  const windowArbiterVariances: number[] = [];

  let latestReport: LoopQualityReport | null = null;
  let bus: EventBus | null = null;
  const unsubs: Array<() => void> = [];

  function resetCycleAccumulators(): void {
    cycleGearSwitchCount = 0;
    cycleProposedCount = 0;
    cycleSuccessCount = 0;
    cycleArbiterConfidences = [];
  }

  function computeVariance(values: number[]): number {
    if (values.length < 2) return 0;
    let mean = 0;
    let m2 = 0;
    for (let i = 0; i < values.length; i++) {
      const delta = values[i] - mean;
      mean += delta / (i + 1);
      const delta2 = values[i] - mean;
      m2 += delta * delta2;
    }
    return m2 / values.length;
  }

  function pushWindow<T>(arr: T[], value: T): void {
    arr.push(value);
    if (arr.length > W) arr.shift();
  }

  function computeReport(): LoopQualityReport | null {
    const totalCycles = windowSwitches.length;
    if (totalCycles < warmup) return null;

    const totalSwitches = windowSwitches.reduce((a, b) => a + b, 0);
    // 1.0 = multiplicative identity; if q computation changes, revisit this value
    const coherence = totalCycles <= 1 ? 1.0 : 1 - totalSwitches / (totalCycles - 1);

    const totalProposed = windowProposed.reduce((a, b) => a + b, 0);
    const totalSuccesses = windowSuccesses.reduce((a, b) => a + b, 0);
    // 1.0 = multiplicative identity; if q computation changes, revisit this value
    const efficiency = totalProposed === 0 ? 1.0 : totalSuccesses / totalProposed;

    let longestStreak = 0;
    let currentStreak = 0;
    for (let i = 0; i < totalCycles; i++) {
      const proposed = windowProposed[i];
      const successes = windowSuccesses[i];
      const isSuccess = proposed === 0 || successes >= proposed;
      if (isSuccess) {
        currentStreak++;
        if (currentStreak > longestStreak) longestStreak = currentStreak;
      } else {
        currentStreak = 0;
      }
    }
    const convergence = totalCycles === 0 ? 0.5 : longestStreak / totalCycles;

    const avgVariance = windowArbiterVariances.length === 0
      ? 0
      : windowArbiterVariances.reduce((a, b) => a + b, 0) / windowArbiterVariances.length;
    const stability = windowArbiterVariances.length === 0
      ? 1.0
      : 1 - Math.min(1, avgVariance / 0.25);

    const vector: LoopQualityVector = {
      coherence: Math.max(0, Math.min(1, coherence)),
      efficiency: Math.max(0, Math.min(1, efficiency)),
      convergence: Math.max(0, Math.min(1, convergence)),
      stability: Math.max(0, Math.min(1, stability)),
    };

    const score =
      weights.coherence * vector.coherence +
      weights.efficiency * vector.efficiency +
      weights.convergence * vector.convergence +
      weights.stability * vector.stability;

    return {
      monitorId: 'default-loop-quality-monitor',
      vector,
      score: Math.max(0, Math.min(1, score)),
      timestamp: Date.now(),
    };
  }

  const handleEvent: EventHandler = (event: AgentEvent) => {
    switch (event.type) {
      case 'loop:started':
        resetCycleAccumulators();
        break;
      case 'gear:arbiter_evaluated': {
        const p = event.payload as { confidence?: number } | undefined;
        if (p && typeof p.confidence === 'number' && cycleArbiterConfidences.length < MAX_ARBITER_CONFIDENCES_PER_CYCLE) {
          cycleArbiterConfidences.push(p.confidence);
        }
        break;
      }
      case 'gear:switch':
        cycleGearSwitchCount++;
        break;
      case 'action:proposed':
        cycleProposedCount++;
        break;
      case 'tool:result': {
        const p = event.payload as { result?: unknown; name?: string } | undefined;
        if (p) cycleSuccessCount++;
        break;
      }
      case 'loop:finished': {
        pushWindow(windowSwitches, cycleGearSwitchCount);
        pushWindow(windowProposed, cycleProposedCount);
        pushWindow(windowSuccesses, cycleSuccessCount);
        pushWindow(windowArbiterVariances, computeVariance(cycleArbiterConfidences));

        const report = computeReport();
        if (report) {
          latestReport = report;
          bus?.emit({
            type: 'loop:quality_updated',
            timestamp: Date.now(),
            payload: {
              monitorId: report.monitorId,
              score: report.score,
              vector: report.vector,
              timestamp: report.timestamp,
            },
          });
        }
        resetCycleAccumulators();
        break;
      }
    }
  };

  return {
    id: 'default-loop-quality-monitor',

    start(eventBus: EventBus): void {
      bus = eventBus;
      const events = [
        'gear:arbiter_evaluated',
        'gear:switch',
        'action:proposed',
        'tool:result',
        'loop:started',
        'loop:finished',
      ];
      for (const type of events) {
        unsubs.push(eventBus.on(type, handleEvent));
      }
    },

    stop(): void {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      bus = null;
    },

    getReport(): LoopQualityReport | null {
      return latestReport;
    },
  };
}
