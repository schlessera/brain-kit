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

import type { AutonomousTurnOptions, BackendBridge } from "@schlessera/brain-ui-sdk/server";

export interface TurnContext {
  bridge: BackendBridge | null;
  signal: AbortSignal | null;
  autonomous?: AutonomousTurnOptions;
  /** Running/queued mutation bodies must unwind before releasing the turn. */
  pendingMutations?: Set<Promise<unknown>>;
  /**
   * The current turn declared `enforceAllowedTools`: a tool outside the
   * allowlist is one the host must decide on its own merits, not one its
   * remembered "always allow" set may answer for. Per turn like the bridge,
   * because the posture belongs to the turn and the gate is registered once
   * per session.
   */
  enforceAllowedTools: boolean;
  /**
   * The current turn declared `noGrantSurface`: nothing can answer a card, so
   * the gate refuses the request here instead of parking it on a bridge whose
   * other end is empty. Per turn like the bridge, for the same reason.
   */
  noGrantSurface: boolean;
}

export function createTurnContext(): TurnContext {
  return {
    bridge: null,
    signal: null,
    enforceAllowedTools: false,
    noGrantSurface: false,
  };
}
