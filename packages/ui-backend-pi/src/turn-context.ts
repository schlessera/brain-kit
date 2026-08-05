/**
 * Per-turn plumbing shared between the backend and one session's curated tools.
 *
 * customTools are registered once when a pi AgentSession is created, but the
 * host hands a fresh BackendBridge (and AbortSignal) to every startTurn. Each
 * session owns its OWN TurnContext, and that session's tools read the current
 * turn's bridge/signal from this mutable holder, which the backend swaps around
 * the session's turn. Because the holder is per session (not shared across the
 * backend), two sessions' turns run concurrently without their tools fighting
 * over one bridge — a session is single-turn (BackendBusyError guards that),
 * but different sessions are independent.
 */

import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";

export interface TurnContext {
  bridge: BackendBridge | null;
  signal: AbortSignal | null;
}

export function createTurnContext(): TurnContext {
  return { bridge: null, signal: null };
}
