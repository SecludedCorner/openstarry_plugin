/**
 * StateView — renders DevToolsState as formatted strings.
 * Pure data view (no Ink dependency) for testability.
 */
import type { DevToolsState } from "../types/state.js";
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatSessionStatus,
  formatToolMetrics,
  formatSystemMetrics,
} from "../state/formatter.js";

export interface StateViewData {
  agentStatus: string;
  sessionLine: string;
  toolLines: string;
  systemLines: string;
}

export function buildStateView(state: DevToolsState): StateViewData {
  return {
    agentStatus: `Agent Status: ${state.agentStatus.toUpperCase()}`,
    sessionLine: formatSessionStatus(state),
    toolLines: formatToolMetrics(state),
    systemLines: formatSystemMetrics(state),
  };
}
