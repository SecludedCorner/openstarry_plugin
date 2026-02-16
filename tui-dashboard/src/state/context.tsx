import React, { createContext, useContext, useReducer } from "react";
import type { TuiState, TuiAction } from "./types.js";
import { tuiReducer, initialState } from "./reducer.js";

interface TuiContextValue {
  state: TuiState;
  dispatch: React.Dispatch<TuiAction>;
}

const TuiContext = createContext<TuiContextValue | null>(null);

export function TuiProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(tuiReducer, initialState);
  return (
    <TuiContext.Provider value={{ state, dispatch }}>
      {children}
    </TuiContext.Provider>
  );
}

export function useTuiState(): TuiContextValue {
  const ctx = useContext(TuiContext);
  if (!ctx) throw new Error("useTuiState must be used within TuiProvider");
  return ctx;
}
