/**
 * DevToolsPanel — manages panel state and visibility.
 * Headless implementation (no Ink/React dependency) for testability.
 * Actual TUI rendering would be added in a future cycle if needed.
 */
import type { AgentEvent } from "@openstarry/sdk";
import type { DevToolsState, MetricsSnapshot } from "../types/state.js";
import type { DevToolsPanelControl } from "../commands/devtools.js";
import type { StateInspector } from "../state/inspector.js";

export interface PanelState {
  visible: boolean;
  currentView: "metrics" | "state" | "events";
  lastSnapshot: MetricsSnapshot | null;
  lastState: DevToolsState | null;
}

export class DevToolsPanel implements DevToolsPanelControl {
  private state: PanelState = {
    visible: false,
    currentView: "metrics",
    lastSnapshot: null,
    lastState: null,
  };

  private readonly inspector: StateInspector;

  constructor(inspector: StateInspector, autoStart: boolean) {
    this.state.visible = autoStart;
    this.inspector = inspector;
  }

  toggle(): boolean {
    this.state.visible = !this.state.visible;
    return this.state.visible;
  }

  isVisible(): boolean {
    return this.state.visible;
  }

  switchView(view: PanelState["currentView"]): void {
    this.state.currentView = view;
  }

  getCurrentView(): PanelState["currentView"] {
    return this.state.currentView;
  }

  onMetricsSnapshot(snapshot: MetricsSnapshot): void {
    this.state.lastSnapshot = snapshot;
    this.state.lastState = this.inspector.snapshot();
  }

  getState(): PanelState {
    return { ...this.state };
  }

  getLatestState(): DevToolsState | null {
    return this.state.lastState;
  }
}
