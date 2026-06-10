/**
 * DevTools plugin configuration interface.
 * FROZEN — Architecture Spec Cycle 12, Section 1.1
 */
export interface DevToolsConfig {
  /** Enable DevTools panel on start. Default: false */
  autoStart?: boolean;

  /** Metrics collection interval in milliseconds. Default: 1000 */
  metricsInterval?: number;

  /** Maximum event log entries to retain. Default: 1000 */
  maxEventLogSize?: number;

  /** Enable verbose debug logging. Default: false */
  verbose?: boolean;

  /** Panel position: 'bottom' | 'right'. Default: 'bottom' */
  position?: "bottom" | "right";

  /** Panel height/width in lines/columns. Default: 15 */
  size?: number;
}

export const DEFAULT_CONFIG: Required<DevToolsConfig> = {
  autoStart: false,
  metricsInterval: 1000,
  maxEventLogSize: 1000,
  verbose: false,
  position: "bottom",
  size: 15,
};
