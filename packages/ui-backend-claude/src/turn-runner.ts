import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import {
  assertTurnPosture,
  BackendBusyError,
  BackendRequestError,
} from "@schlessera/brain-ui-sdk/server";

import type { ClaudeBackendOptions, BackendLogFn } from "./options.js";
import { getProfile, type InferenceProfile } from "./profiles.js";
import { createClaudeSdkTurn } from "./sdk-options.js";
import { StreamAdapter } from "./stream-adapter.js";
import type { ActiveTurn } from "./turn-lock.js";
import { createTurnLockBinding } from "./turn-lock.js";
import { DEFAULT_ALLOWED_TOOLS } from "./tool-policy.js";
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";

const BACKEND_ID = "claude";

export function createClaudeTurnRunner(options: {
  backend: ClaudeBackendOptions;
  resolveProfiles(): InferenceProfile[];
  confirmPatterns: readonly RegExp[];
  writeLock: KeyedLock;
  lockWaitMs: number;
  log: BackendLogFn;
}): (req: StartTurnRequest) => Promise<void> {
  // Busy-ness is PER SESSION: one running turn per session key. Resuming a
  // session that already has a running turn rejects BackendBusyError; a NEW
  // turn (no sessionId yet) gets a unique placeholder key, so two concurrent
  // new-session turns always coexist. The slot is re-keyed to the real session
  // id once the SDK reports it.
  const activeTurns = new Map<string, ActiveTurn>();
  const queryFn = options.backend.queryFn ?? query;

  return async function startTurn(req: StartTurnRequest): Promise<void> {
    // Before anything is claimed or emitted: a refused posture rejects, per
    // the startTurn contract, and leaves no turn behind.
    assertTurnPosture(req);
    const profile = resolveProfile(options.resolveProfiles(), req.profileId);
    if (req.sessionId !== undefined && activeTurns.has(req.sessionId)) {
      throw new BackendBusyError(BACKEND_ID, req.sessionId);
    }

    const turn: ActiveTurn = { pendingReleases: new Map(), ended: false };
    const turnLock = createTurnLockBinding({
      turn,
      writeLock: options.writeLock,
      lockWaitMs: options.lockWaitMs,
      log: options.log,
    });
    // Placeholder key for a new session; the real id (a resume's requested id,
    // or the SDK-minted id for a new session) replaces it below.
    let turnKey = req.sessionId ?? `new:${crypto.randomUUID()}`;
    activeTurns.set(turnKey, turn);

    // The host owns cancellation. Mirror its signal onto an internal
    // AbortController that the SDK query listens to.
    const abortController = new AbortController();
    const onHostAbort = () => abortController.abort();
    if (req.signal.aborted) abortController.abort();
    else req.signal.addEventListener("abort", onHostAbort, { once: true });

    const adapter = new StreamAdapter(req.bridge.activity);
    // Scope every frame to its session once the identity is known. For a
    // resume that is up front (the requested id); for a new session it is null
    // until the SDK reports it, so the only pre-identity frames (status/
    // thinking) go out unscoped, then everything after is scoped. result and
    // session_info already carry their own sessionId; the spread is a no-op on
    // them.
    let sessionId: string | null = req.sessionId ?? null;
    const emit = (msg: ServerMessage): void => {
      // The cast is safe: backends never emit the (unscoped) server_hello
      // frame, and every other ServerMessage accepts a sessionId.
      req.bridge.emit(sessionId !== null ? ({ ...msg, sessionId } as ServerMessage) : msg);
    };
    const startedAt = Date.now();
    // Hoisted: the catch/finally paths must know whether the stream already
    // produced its terminal result — a stream that yields a result and THEN
    // throws must not get a second one.
    let sawResult = false;
    /**
     * Unified terminal frame for cancelled/failed turns. With a session
     * identity that is a `result`; WITHOUT one (an abort or failure before
     * the SDK reported a session) the contract's terminal is a bare `error`,
     * so a client keying on result/error is never left hanging.
     */
    const emitTerminal = (outcome: "error" | "cancelled"): void => {
      if (sawResult) return;
      sawResult = true;
      if (sessionId === null) {
        emit({
          type: "error",
          code: outcome === "cancelled" ? "CANCELLED" : "CLAUDE_ERROR",
          message:
            outcome === "cancelled"
              ? "Turn cancelled before the session was established"
              : "Turn failed before the session was established",
        });
        return;
      }
      // costUsd deliberately absent (unknown); duration is real, numTurns 0 =
      // "no completed turns" for a turn that never finished.
      emit({
        type: "result",
        sessionId,
        outcome,
        durationMs: Date.now() - startedAt,
        numTurns: 0,
        isError: outcome === "error",
      });
    };

    try {
      const allowedTools =
        profile.allowedTools ?? options.backend.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
      const sdkTurn = createClaudeSdkTurn({
        backend: options.backend,
        req,
        profile,
        abortController,
        allowedTools,
        confirmPatterns: options.confirmPatterns,
        turnLock,
        log: options.log,
      });
      const result = queryFn({ prompt: sdkTurn.prompt, options: sdkTurn.options });

      let announced = false;
      for await (const msg of result) {
        // Emit session_info as soon as the session identity is known, before
        // any content frames (contract requirement).
        if (!announced && msg.session_id) {
          announced = true;
          if (sessionId === null) {
            // New session: adopt the SDK-minted id for scoping and re-key the
            // busy slot from its placeholder, so a resume of this session while
            // it still runs is detected as busy.
            sessionId = msg.session_id;
            activeTurns.delete(turnKey);
            activeTurns.set(sessionId, turn);
            turnKey = sessionId;
          }
          emit({
            type: "session_info",
            sessionId,
            isNew: !req.sessionId,
            providerId: profile.id,
            backendId: BACKEND_ID,
          });
        }
        for (const serverMsg of adapter.adapt(msg)) {
          // Exactly one terminal frame per turn, whatever the stream does:
          // a second SDK result is dropped rather than forwarded.
          if (serverMsg.type === "result") {
            if (sawResult) continue;
            sawResult = true;
          }
          // Release the write lock the moment a mutating tool's result frame
          // lands (the turn-end backstop covers anything still held).
          if (serverMsg.type === "tool_result") {
            turnLock.releaseForTool(serverMsg.toolUseId);
          }
          emit(serverMsg);
        }
      }

      // Stream ended without its terminal result: aborted → cancelled; not
      // aborted → an abnormal end the client must still be released from.
      if (!sawResult) {
        if (abortController.signal.aborted) {
          emit({ type: "status", status: "cancelled" });
          emitTerminal("cancelled");
        } else {
          emit({
            type: "error",
            code: "CLAUDE_NO_RESULT",
            message: "Backend stream ended without a result",
          });
          emitTerminal("error");
        }
      }
    } catch (err) {
      // error/cancelled frames are diagnostics; the terminal frame is the
      // result with an outcome (for turns that have a session identity — a
      // turn that died before any session id ends on the bare error).
      // emitTerminal itself no-ops when the stream already delivered its
      // result before throwing. Diagnostics only make sense BEFORE the
      // terminal frame; when the stream already delivered its result, the turn
      // is over and nothing may follow it.
      if (sawResult) {
        // Terminal frame already sent — swallow the late failure.
      } else if (abortController.signal.aborted) {
        emit({ type: "status", status: "cancelled" });
        emitTerminal("cancelled");
      } else {
        emit({
          type: "error",
          code: "CLAUDE_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
        emitTerminal("error");
      }
    } finally {
      req.signal.removeEventListener("abort", onHostAbort);
      // Backstop: release any write lock still held (a mutating tool whose
      // result never streamed, e.g. an aborted turn) and free the busy slot.
      turnLock.close();
      activeTurns.delete(turnKey);
    }
  };
}

function resolveProfile(
  profiles: InferenceProfile[],
  profileId: string | undefined
): InferenceProfile {
  // profileId is only meaningful for new sessions; resumed sessions are pinned
  // host-side and pass their original id back through. Undefined = default.
  if (profileId === undefined) return profiles[0]!;
  const profile = getProfile(profiles, profileId);
  if (!profile) throw new BackendRequestError(`Unknown profile id: ${profileId}`);
  return profile;
}
