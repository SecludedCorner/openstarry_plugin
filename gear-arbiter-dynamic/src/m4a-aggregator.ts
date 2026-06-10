/**
 * m4a-aggregator — M4a aggregation framework (Rule #59 dual-track).
 * Tracks shadow decision records and generates per-round reports.
 * @see Plan44 W1-3, W1-6
 */

import type { ShadowDecisionRecord, M4aCategoryRecord, M4aReport } from './m4a-types.js';

// HYPOTHESIS thresholds (Rule #59, AC-W1-5: ALL labeled HYPOTHESIS, NOT numeric comparisons)
const HYPOTHESIS_THRESHOLDS: Readonly<Record<string, string>> = {
  informational: 'HYPOTHESIS: A > 0.85',
  read_only: 'HYPOTHESIS: A > 0.80',
  state_modifying: 'HYPOTHESIS: monitoring-only (Rule #57)',
  destructive: 'HYPOTHESIS: monitoring-only (Rule #57)',
};

// Categories that are monitoring-only (Rule #57, AC-W1-4)
const MONITORING_ONLY_CATEGORIES: ReadonlySet<string> = new Set([
  'state_modifying',
  'destructive',
]);

export function isMonitoringOnly(category: string): boolean {
  return MONITORING_ONLY_CATEGORIES.has(category);
}

export class M4aAggregator {
  private readonly records: ShadowDecisionRecord[] = [];

  /** Append a shadow decision record (append-only, W1-2). */
  append(record: ShadowDecisionRecord): void {
    this.records.push(record);
  }

  /** Get all stored records (read-only view). */
  getRecords(): readonly ShadowDecisionRecord[] {
    return this.records;
  }

  /** Generate per-round M4a report with per-category agreement + deviation. */
  generateReport(roundId: string): M4aReport {
    const byCategory = new Map<string, ShadowDecisionRecord[]>();
    for (const r of this.records) {
      const list = byCategory.get(r.category) ?? [];
      list.push(r);
      byCategory.set(r.category, list);
    }

    const categories: M4aCategoryRecord[] = [];
    let totalAgreements = 0;
    let totalDecisions = 0;

    for (const [category, records] of byCategory) {
      const agreements = records.filter(r => r.agrees).length;
      const disagreements = records.length - agreements;
      const agreementRate = records.length > 0 ? agreements / records.length : 0;
      // Mean deviation on disagreements only (Rule #59 dual-track)
      const meanDeviation = disagreements > 0
        ? records.filter(r => !r.agrees).reduce((sum, r) => sum + r.deviation, 0) / disagreements
        : 0;

      categories.push({
        category,
        totalDecisions: records.length,
        agreements,
        disagreements,
        agreementRate,
        meanDeviation,
        monitoringOnly: isMonitoringOnly(category),
        hypothesisThreshold: HYPOTHESIS_THRESHOLDS[category] ?? 'HYPOTHESIS: N/A',
      });

      totalAgreements += agreements;
      totalDecisions += records.length;
    }

    return {
      roundId,
      timestamp: Date.now(),
      categories,
      aggregateAgreementRate: totalDecisions > 0 ? totalAgreements / totalDecisions : 0,
      shadowDecisionCount: this.records.length,
    };
  }

  /** Clear all records (e.g., on Phase3Config change). */
  clear(): void {
    this.records.length = 0;
  }
}
