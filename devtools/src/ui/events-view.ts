/**
 * EventsView — renders event log as formatted strings.
 * Pure data view (no Ink dependency) for testability.
 */
import type { DevToolsState } from "../types/state.js";

export interface EventViewEntry {
  time: string;
  type: string;
  summary: string;
}

export function buildEventsView(
  events: DevToolsState["recentEvents"],
  maxEntries = 20,
): EventViewEntry[] {
  return events.slice(-maxEntries).reverse().map((e) => ({
    time: new Date(e.timestamp).toLocaleTimeString(),
    type: e.type,
    summary: e.payload ? truncatePayload(e.payload) : "",
  }));
}

function truncatePayload(payload: unknown): string {
  const str = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (str.length > 80) return str.slice(0, 77) + "...";
  return str;
}
