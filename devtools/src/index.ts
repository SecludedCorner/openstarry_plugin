/**
 * DevTools Plugin — agent introspection and debugging.
 * Implements Plan11 (Cycle 12) — DevTools Plugin & E2E Testing Framework.
 *
 * Five Aggregates mapping:
 *   IUI (色蘊)       — DevToolsPanel (state display)
 *   IListener (受蘊)  — MetricsListener (event collection)
 *   SlashCommands     — /devtools, /metrics, /debug
 */
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IUI,
  IListener,
  AgentEvent,
} from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import type { DevToolsConfig } from "./types/config.js";
import { DEFAULT_CONFIG } from "./types/config.js";
import type { MetricsSnapshot } from "./types/state.js";
import { MetricsCollector } from "./metrics/collector.js";
import { processEvent } from "./metrics/aggregator.js";
import { StateInspector, EventLog } from "./state/inspector.js";
import { DevToolsPanel } from "./ui/devtools-panel.js";
import { createDevtoolsCommand } from "./commands/devtools.js";
import { createMetricsCommand } from "./commands/metrics.js";
import { createDebugCommand } from "./commands/debug.js";

export function createDevtoolsPlugin(config?: Partial<DevToolsConfig>): IPlugin {
  return {
    manifest: {
      name: "devtools",
      version: "0.1.0-alpha",
      description: "DevTools plugin for OpenStarry agent introspection and debugging",
      sandbox: { enabled: false }, // DevTools needs direct process access for metrics
      skandha: 'samskara' as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const cfg: Required<DevToolsConfig> = { ...DEFAULT_CONFIG, ...config };

      // Initialize core components
      const collector = new MetricsCollector();
      const eventLog = new EventLog(cfg.maxEventLogSize);
      const inspector = new StateInspector(ctx, collector, eventLog);
      const panel = new DevToolsPanel(inspector, cfg.autoStart);

      let metricsInterval: ReturnType<typeof setInterval> | null = null;
      let unsubscribeAll: (() => void) | null = null;

      // IListener: collects events for metrics
      const metricsListener: IListener = {
        skandha: 'rupa' as const,
        id: "devtools-metrics-listener",
        name: "DevTools Metrics Listener",

        async start(): Promise<void> {
          // Subscribe to all events for metrics collection
          unsubscribeAll = ctx.bus.onAny((event: AgentEvent) => {
            processEvent(event, collector);
            eventLog.push(event);
            inspector.updateStatus(event);

            if (cfg.verbose) {
              console.log(`[devtools] ${event.type}`);
            }
          });

          // Periodic metrics snapshot emission
          metricsInterval = setInterval(() => {
            const snapshot = collector.getSnapshot();
            panel.onMetricsSnapshot(snapshot);
            ctx.bus.emit({
              type: AgentEventType.METRICS_SNAPSHOT,
              timestamp: Date.now(),
              payload: snapshot,
            });
          }, cfg.metricsInterval);
        },

        async stop(): Promise<void> {
          if (metricsInterval) {
            clearInterval(metricsInterval);
            metricsInterval = null;
          }
          if (unsubscribeAll) {
            unsubscribeAll();
            unsubscribeAll = null;
          }
        },
      };

      // IUI: provides event handler for panel updates
      const devtoolsUI: IUI = {
        skandha: 'rupa' as const,
        id: "devtools-panel",
        name: "DevTools Panel",

        onEvent(event: AgentEvent): void {
          // Panel updates are handled by the metrics listener's periodic snapshots
          // This IUI is a lifecycle marker
        },

        async start(): Promise<void> {
          // Headless panel — no Ink rendering in this version
          // Future: render Ink component for TUI display
        },

        async stop(): Promise<void> {
          // Cleanup handled by dispose
        },
      };

      // Slash commands
      const commands = [
        createDevtoolsCommand(panel),
        createMetricsCommand(collector),
        createDebugCommand(cfg),
      ];

      return {
        listeners: [metricsListener],
        ui: [devtoolsUI],
        commands,
        async dispose(): Promise<void> {
          await metricsListener.stop?.();
          collector.reset();
          eventLog.clear();
        },
      };
    },
  };
}

export default createDevtoolsPlugin;
export type { DevToolsConfig } from "./types/config.js";
export type { DevToolsState, IMetricsCollector, MetricsSnapshot } from "./types/state.js";
