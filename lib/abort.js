// Per-run cancellation. The API route runs each pipeline inside runContext with an
// AbortSignal; LLM and paper fetches read it so a Stop click ends the run at once.
import { AsyncLocalStorage } from "node:async_hooks";

export const runContext = new AsyncLocalStorage();

export function runSignal() {
  return runContext.getStore() || null;
}

export function throwIfStopped() {
  if (runSignal()?.aborted) {
    const err = new Error("Stopped by user");
    err.name = "AbortError";
    throw err;
  }
}

// Combine the run signal with a local one (e.g. a timeout).
export function withRunSignal(signal) {
  const rs = runSignal();
  if (!rs) return signal;
  if (!signal) return rs;
  if (AbortSignal.any) return AbortSignal.any([rs, signal]);
  const ctrl = new AbortController();
  for (const sg of [rs, signal]) {
    if (sg.aborted) ctrl.abort();
    else sg.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
