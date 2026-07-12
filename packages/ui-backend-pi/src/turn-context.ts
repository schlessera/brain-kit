/**
 * Per-turn plumbing shared between the backend and its curated tools.
 *
 * customTools are registered once when the pi AgentSession is created, but the
 * host hands a fresh BackendBridge (and AbortSignal) to every startTurn. The
 * tools therefore read the *current* turn's bridge/signal from this mutable
 * holder, which the backend swaps at the start of each turn. Safe because the
 * backend runs one turn at a time (BackendBusyError on concurrency).
 */

import type { BackendBridge } from "@brainform/ui-sdk/server";

export interface TurnContext {
  bridge: BackendBridge | null;
  signal: AbortSignal | null;
}

export function createTurnContext(): TurnContext {
  return { bridge: null, signal: null };
}
