import React from "react";
import { Box, useInput, useApp } from "ink";
import { TuiProvider, useTuiState } from "./state/context.js";
import { Header } from "./components/header.js";
import { ChatArea } from "./components/chat-area.js";
import { EventLog } from "./components/event-log.js";
import { Footer } from "./components/footer.js";
import { InputArea } from "./components/input-area.js";
import type { TuiAction } from "./state/types.js";

// Context to pass submitInput callback from InputBridge to InputArea
const SubmitInputContext = React.createContext<((text: string) => void) | null>(null);

function DashboardLayout() {
  const { state, dispatch } = useTuiState();
  const { exit } = useApp();
  const submitInputCallback = React.useContext(SubmitInputContext);

  // Global keyboard shortcuts (only active in browse mode)
  useInput(
    (input, key) => {
      // Skip if in input mode — InputArea handles keys
      if (state.inputMode === "input") return;

      if (input === "q") {
        exit();
        return;
      }
      if (key.tab) {
        dispatch({ type: "TOGGLE_EVENT_LOG" });
        return;
      }
      // Enter or 'i' key — enter input mode (Plan09)
      if (key.return || input === "i") {
        dispatch({ type: "SET_INPUT_MODE", payload: "input" });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: "SCROLL_CHAT", payload: { delta: 1 } });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: "SCROLL_CHAT", payload: { delta: -1 } });
        return;
      }
      // Event log scrolling (only when visible)
      if (state.isEventLogVisible && input === "[") {
        dispatch({ type: "SCROLL_EVENT_LOG", payload: { delta: 1 } });
        return;
      }
      if (state.isEventLogVisible && input === "]") {
        dispatch({ type: "SCROLL_EVENT_LOG", payload: { delta: -1 } });
        return;
      }
    },
    { isActive: state.inputMode === "browse" },
  );

  return (
    <Box flexDirection="column" width="100%">
      <Header />
      <Box flexGrow={1}>
        <ChatArea />
        <EventLog />
      </Box>
      <InputArea onSubmit={submitInputCallback ?? undefined} />
      <Footer />
    </Box>
  );
}

export interface TuiAppProps {
  externalDispatch?: (dispatch: React.Dispatch<TuiAction>) => void;
  onSubmitInput?: (callback: (text: string) => void) => void;
}

export function TuiApp({ externalDispatch, onSubmitInput }: TuiAppProps) {
  const [submitCallback, setSubmitCallback] = React.useState<((text: string) => void) | null>(null);

  return (
    <TuiProvider>
      <DispatchBridge externalDispatch={externalDispatch} />
      <InputBridge onSubmitInput={onSubmitInput} setSubmitCallback={setSubmitCallback} />
      <SubmitInputContext.Provider value={submitCallback}>
        <DashboardLayout />
      </SubmitInputContext.Provider>
    </TuiProvider>
  );
}

/**
 * Internal bridge component that exposes the dispatch function
 * to the plugin host (TuiUI) so events can be dispatched from
 * outside the React tree.
 */
function DispatchBridge({
  externalDispatch,
}: {
  externalDispatch?: (dispatch: React.Dispatch<TuiAction>) => void;
}) {
  const { dispatch } = useTuiState();

  React.useEffect(() => {
    externalDispatch?.(dispatch);
  }, [dispatch, externalDispatch]);

  return null;
}

/**
 * InputBridge component that exposes the submitInput callback
 * to the plugin factory, allowing React to call ctx.pushInput()
 * indirectly (Plan09).
 */
function InputBridge({
  onSubmitInput,
  setSubmitCallback,
}: {
  onSubmitInput?: (callback: (text: string) => void) => void;
  setSubmitCallback: (callback: (text: string) => void) => void;
}) {
  const { dispatch } = useTuiState();

  React.useEffect(() => {
    const handleSubmit = (text: string) => {
      // Local echo + submit
      dispatch({
        type: "SUBMIT_INPUT",
        payload: { text, timestamp: Date.now() },
      });
      // Add user message
      dispatch({
        type: "ADD_MESSAGE",
        payload: {
          id: `user-${Date.now()}`,
          timestamp: Date.now(),
          type: "user",
          content: text,
        },
      });
      // Switch back to browse mode
      dispatch({ type: "SET_INPUT_MODE", payload: "browse" });
    };

    setSubmitCallback(handleSubmit);
    onSubmitInput?.(handleSubmit);
  }, [dispatch, onSubmitInput, setSubmitCallback]);

  return null;
}
