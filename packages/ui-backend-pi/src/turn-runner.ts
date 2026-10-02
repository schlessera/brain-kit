import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  ChatImageAttachment,
  ServerMessage,
  StartTurnRequest,
  TurnFailure,
} from "@schlessera/brain-ui-sdk/server";
import { assertTurnPosture } from "@schlessera/brain-ui-sdk/server";
import { resolveThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import type { CreatePiBackendOptions } from "./backend-options.js";
import { configuredProfiles, resolveModelSpec } from "./profiles.js";

import { mapPiEvent } from "./event-adapter.js";
import type { SessionPool } from "./session-pool.js";
import {
  createTurnFailureTracker,
  failureFromPiError,
  type TurnFailureTracker,
} from "./turn-failure.js";
import {
  createUsageAccumulator,
  snapshotCost,
  turnCost,
  type TurnUsageAccumulator,
} from "./usage.js";

const BACKEND_ID = "pi";

export function createPiTurnRunner(
  pool: SessionPool,
  options: CreatePiBackendOptions
): (req: StartTurnRequest) => Promise<void> {
  return async function startTurn(req: StartTurnRequest): Promise<void> {
    const startedAt = Date.now();
    // pi has none of the runtime shortcuts the pairing guards against, but the
    // declaration is refused here too so it means the same on both backends.
    assertTurnPosture(req, !options.sessionFactory);
    // acquire() claims the session (per-session busy) and validates caller
    // input. On any throw — BackendBusyError / BackendRequestError — nothing
    // has been emitted and the promise REJECTS, per the startTurn contract.
    const { entry, isNew } = await pool.acquire(req);
    const { session, turnContext } = entry;
    const sessionId = session.sessionId;
    // Scope every frame this turn emits to its session so a multiplexed client
    // can demux concurrent sessions. Follow-up frames flow through this same
    // emit (the subscription below stays live for the whole turn).
    const emit = (msg: ServerMessage) => req.bridge.emit(scopeFrame(msg, sessionId));

    // Bind this session's tool plumbing to the current turn's bridge/signal.
    turnContext.bridge = req.bridge;
    const toolController = new AbortController();
    if (req.signal.aborted) toolController.abort();
    turnContext.signal = toolController.signal;
    const pendingMutations = new Set<Promise<unknown>>();
    turnContext.pendingMutations = pendingMutations;
    turnContext.enforceAllowedTools = req.enforceAllowedTools === true;
    turnContext.noGrantSurface = req.noGrantSurface === true;
    let yielded = false;
    turnContext.autonomous = req.autonomous ? { ...req.autonomous, onYield: req.autonomous.onYield ? (key) => {
      if (yielded || req.signal.aborted) return;
      yielded = true;
      try { req.autonomous!.onYield!(key); }
      catch { emit({ type: "error", code: "AUTONOMOUS_YIELD_FAILED", message: "Autonomous yield checkpoint failed." }); }
      finally { cancelled = true; toolController.abort(); void session.abort(); }
    } : undefined } : undefined;
    // Everything from here on runs inside the try: a throw from subscribe() or
    // the first emit() would otherwise leave entry.running stuck true, bricking
    // this session id (later turns reject busy and eviction skips it).
    let unsubscribe: () => void = () => {};
    // Latch cancellation when it happens. A post-hoc signal.aborted check would
    // mislabel a completed turn aborted afterward and discard a paid answer.
    let cancelled = req.signal.aborted;
    const onAbort = () => {
      cancelled = true;
      toolController.abort();
      void session.abort();
    };
    const costBefore = snapshotCost(session);
    const usage = createUsageAccumulator();
    const failures = createTurnFailureTracker();
    let failed = false;
    let thrown: TurnFailure | null = null;

    try {
      // Always reset from the current profile, even for an in-memory resume.
      // Pre-resolve downward: pi's own unsupported-level clamp can raise effort.
      const profile = req.profileId || !session.model
        ? resolveModelSpec(options, req.profileId)
        : configuredProfiles(options)?.find((candidate) => candidate.model === session.model?.id && candidate.vendor === session.model?.provider);
      const defaultLevel = profile?.thinkingLevel ?? "medium";
      const levels = session.getAvailableThinkingLevels?.();
      const effort = levels ? resolveThinkingLevel(req.thinkingLevel ?? defaultLevel, levels) : undefined;
      if (effort !== undefined) session.setThinkingLevel?.(effort, { persist: false });
      if (!req.signal.aborted) {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
      unsubscribe = session.subscribe(makeEventHandler(emit, usage, failures));
      // session_info must precede any content frames for a new session.
      if (req.autonomous) {
        try {
          req.bridge.activity?.({ kind: "autonomous_identity", runtimeSessionId: sessionId,
            backendId: BACKEND_ID, ...(req.profileId ? { profileId: req.profileId } : {}) });
        } catch { /* Observability must not fail the observed turn. */ }
      } else emit({
        type: "session_info",
        sessionId,
        isNew,
        backendId: BACKEND_ID,
        ...(req.profileId ? { providerId: req.profileId } : {}),
        ...(req.thinkingLevel !== undefined ? {
          thinkingLevel: req.thinkingLevel,
          ...(session.thinkingLevel !== undefined ? { effectiveThinkingLevel: session.thinkingLevel } : {}),
        } : {}),
      });
      // An already-aborted signal never fires "abort", and aborting a session
      // that has not been prompted does not cancel a LATER prompt — so never
      // start one. Prompting anyway would hang until the model finished,
      // leaking the concurrency slot for the whole turn.
      if (!req.signal.aborted) {
        const images = toImages(req);
        emit({ type: "status", status: "thinking" });
        await session.prompt(req.prompt, images.length > 0 ? { images } : undefined);
      }
    } catch (err) {
      // Runtime failure (no model/auth, provider unreachable) → diagnostic
      // error frame, then a terminal result with outcome "error". The promise
      // RESOLVES. A host abort also surfaces as a throw — that is cancellation,
      // not an error; the abort path below owns it.
      failed = true;
      if (!cancelled) {
        emit({ type: "error", code: "agent_error", message: errorMessage(err) });
        thrown = failureFromPiError(errorMessage(err));
      }
    } finally {
      // An SDK abort can finish prompt() before a subprocess/tool body exits.
      // Retain session/lock ownership until our actual mutation bodies drain.
      toolController.abort();
      await Promise.allSettled([...pendingMutations]);
      unsubscribe();
      req.signal.removeEventListener("abort", onAbort);
      turnContext.bridge = null;
      turnContext.signal = null;
      turnContext.autonomous = undefined;
      turnContext.pendingMutations = undefined;
      turnContext.enforceAllowedTools = false;
      turnContext.noGrantSurface = false;
      // Now that this session is idle, drop cold sessions above the cap.
      pool.finish(entry);
    }

    const costUsd = turnCost(costBefore, snapshotCost(session));
    const wireUsage = usage.toWire();
    if (cancelled) {
      emit({ type: "status", status: "cancelled" });
      emit({
        type: "result",
        sessionId,
        outcome: "cancelled",
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(wireUsage ? { usage: wireUsage } : {}),
        durationMs: Date.now() - startedAt,
        numTurns: 1,
        isError: false,
      });
      return;
    }
    // A provider failure does not throw: prompt() resolves, and the turn's
    // last answer is the error (#575). Its usage is already in `wireUsage`,
    // counted once from its message_end like any other answer.
    const failure = failures.failure(thrown ?? undefined);
    if (failure) failed = true;
    // Parity with the claude backend, which emits idle before its terminal
    // result — the two backends must produce interchangeable frame streams.
    emit({ type: "status", status: "idle" });
    emit({
      type: "result",
      sessionId,
      outcome: failed ? "error" : "success",
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(wireUsage ? { usage: wireUsage } : {}),
      durationMs: Date.now() - startedAt,
      numTurns: 1,
      isError: failed,
      ...(failure ? { failure } : {}),
    });
  };
}

/**
 * Stamp `sessionId` on an outgoing frame. Every ServerMessage variant permits a
 * string sessionId (SessionScoped frames make it optional; `result` and
 * `session_info` already require it), so this is safe for all of them.
 */
function scopeFrame(msg: ServerMessage, sessionId: string): ServerMessage {
  return { ...msg, sessionId } as ServerMessage;
}

/** Translate pi AgentSession events into wire-protocol frames. */
function makeEventHandler(
  emit: (msg: ServerMessage) => void,
  usage: TurnUsageAccumulator,
  failures: TurnFailureTracker
) {
  return (event: AgentSessionEvent): void => {
    usage.observe(event);
    for (const frame of failures.observe(event)) emit(frame);
    for (const frame of mapPiEvent(event)) emit(frame);
  };
}

export function toImages(req: { attachments?: ChatImageAttachment[] }): ImageContent[] {
  if (!req.attachments || req.attachments.length === 0) return [];
  return req.attachments.map((attachment) => ({
    type: "image",
    data: attachment.data,
    mimeType: attachment.mediaType,
  }));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
