import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IUI,
  IListener,
  AgentEvent,
} from "@openstarry/sdk";
import type { TuiAction } from "./state/types.js";
import { eventToAction } from "./utils/event-mapper.js";

export function createTuiDashboardPlugin(): IPlugin {
  return {
    manifest: {
      name: "tui-dashboard",
      version: "0.1.0-alpha",
      description: "TUI Dashboard for monitoring OpenStarry agents",
    },
    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      let dispatch: React.Dispatch<TuiAction> | null = null;
      let inkInstance: { unmount: () => void; cleanup: () => void } | null = null;
      let sessionId: string | null = null;
      let submitInput: ((text: string) => void) | null = null;
      // Buffer events that arrive before React mounts
      const pendingActions: TuiAction[] = [];

      // Helper to handle local slash commands
      function handleSlashCommand(text: string): boolean {
        if (!text.startsWith("/")) return false;

        const command = text.split(" ")[0].toLowerCase();
        switch (command) {
          case "/quit":
            // Exit handled by useApp().exit() in React
            if (dispatch) {
              dispatch({
                type: "ADD_MESSAGE",
                payload: {
                  id: `system-${Date.now()}`,
                  timestamp: Date.now(),
                  type: "system",
                  content: "Quitting TUI...",
                },
              });
            }
            return true;

          case "/clear":
            if (dispatch) {
              dispatch({ type: "CLEAR_CHAT" });
            }
            return true;

          case "/help":
            if (dispatch) {
              const helpText = `Available Commands:
/help — Show this help message
/clear — Clear chat history
/quit — Exit the TUI dashboard

Keyboard Shortcuts:
- Browse mode: q=quit, Tab=log, i=input, ↑↓=scroll
- Input mode: Enter=send, Esc=cancel, ↑↓=history`;

              dispatch({
                type: "ADD_MESSAGE",
                payload: {
                  id: `help-${Date.now()}`,
                  timestamp: Date.now(),
                  type: "system",
                  content: helpText,
                },
              });
            }
            return true;

          default:
            return false; // Not a local command
        }
      }

      const tuiUI: IUI = {
        id: "tui-dashboard",
        name: "TUI Dashboard",

        onEvent(event: AgentEvent): void {
          const action = eventToAction(event);
          if (!action) return;

          if (dispatch) {
            dispatch(action);
          } else {
            // Buffer until dispatch is available
            pendingActions.push(action);
          }
        },

        async start(): Promise<void> {
          const { render } = await import("ink");
          const { TuiApp } = await import("./tui-app.js");
          const React = await import("react");

          // Create session for this TUI instance (Plan09)
          const session = ctx.sessions.create({
            interface: "tui",
          });
          sessionId = session.id;

          const handleSubmitInput = (setReactCallback: (handler: (text: string) => void) => void) => {
            const handler = (text: string) => {
              // Handle local slash commands first
              if (handleSlashCommand(text)) {
                return;
              }

              // Determine input type
              const inputType = text.startsWith("/") ? "slash_command" : "user_input";

              // Push to core via ctx.pushInput
              ctx.pushInput({
                source: "tui-input",
                inputType,
                data: text,
                sessionId: sessionId ?? undefined,
              });
            };
            submitInput = handler;
            setReactCallback(handler);
          };

          const props: {
            externalDispatch?: (d: React.Dispatch<TuiAction>) => void;
            onSubmitInput?: (setCallback: (handler: (text: string) => void) => void) => void;
          } = {
            externalDispatch: (d: React.Dispatch<TuiAction>) => {
              dispatch = d;
              // Flush buffered events
              for (const action of pendingActions.splice(0)) {
                d(action);
              }
            },
            onSubmitInput: handleSubmitInput,
          };

          inkInstance = render(
            React.createElement(TuiApp as any, props),
            { exitOnCtrlC: false },
          );
        },

        async stop(): Promise<void> {
          // Destroy session (Plan09)
          if (sessionId) {
            ctx.sessions.destroy(sessionId);
            sessionId = null;
          }

          dispatch = null;
          submitInput = null;
          pendingActions.length = 0;
          if (inkInstance) {
            inkInstance.unmount();
            inkInstance = null;
          }
        },
      };

      // IListener implementation (Plan09) — lifecycle marker only
      const tuiListener: IListener = {
        id: "tui-listener",
        name: "TUI Dashboard Listener",
        async start(): Promise<void> {
          // No-op: actual input capture happens in React via useInput
        },
        async stop(): Promise<void> {
          // No-op: cleanup handled by TuiUI.stop()
        },
      };

      return {
        ui: [tuiUI],
        listeners: [tuiListener],
        async dispose(): Promise<void> {
          await tuiUI.stop?.();
        },
      };
    },
  };
}

export default createTuiDashboardPlugin;
export type { TuiState, TuiAction, Message, EventLogEntry } from "./state/types.js";
