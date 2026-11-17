import { FIRST_PARTY_FAILURE_CLASSES, type StateRoomObservation } from "@schlessera/brain-ui-sdk/protocol";
import type { ServerMessage, StartTurnRequest, TurnFailure } from "@schlessera/brain-ui-sdk/server";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";

import { SessionTooLargeError } from "./worker-state.js";
import { workerStateClass } from "./worker-spawn.js";
import type { WorkerLimitReporter } from "./turn-reporting.js";

export type ResultFrame = Extract<ServerMessage, { type: "result" }>;

/** Why the turn failed when the host did not cancel it: a refusal or a named failure. */
export interface TurnRefusal {
  code: string;
  message: string;
  failure?: TurnFailure;
}

/** The worker hooks the terminal waits for and consults, bound once the SDK turn is built. */
export interface TurnTerminalWorker {
  finishWorker?: () => Promise<void>;
  workerFailure?: () => TurnFailure | undefined;
  workerStartFailure?: () => unknown;
}

/**
 * The turn's frame sink. Every frame is scoped to its session once the
 * identity is known. For a resume that is up front (the requested id); for a
 * new session it is null until the SDK reports it, so the only pre-identity
 * frames (status/thinking) go out unscoped, then everything after is scoped.
 * result and session_info already carry their own sessionId; the spread is a
 * no-op on them.
 */
export class TurnFrames {
  sessionId: string | null;
  /** The worker's runtime-state observation, attached to a result frame. */
  stateRoom: (() => StateRoomObservation | undefined) | undefined;
  readonly #bridge: StartTurnRequest["bridge"];

  constructor(bridge: StartTurnRequest["bridge"], sessionId: string | null) {
    this.#bridge = bridge;
    this.sessionId = sessionId;
  }

  emit(msg: ServerMessage): void {
    const observation = msg.type === "result"
      && !["worker_state_busy", "session_too_large", "worker_state_exceeded"].includes(msg.failure?.errorClass ?? "")
      ? this.stateRoom?.() : undefined;
    if (msg.type === "result" && observation) msg = { ...msg, stateRoom: observation };
    // The cast is safe: backends never emit the (unscoped) server_hello
    // frame, and every other ServerMessage accepts a sessionId.
    this.#bridge.emit(this.sessionId !== null ? ({ ...msg, sessionId: this.sessionId } as ServerMessage) : msg);
  }
}

/**
 * The turn's terminal state: whether its terminal result was seen, whether it
 * was refused or its prompt withheld, and the rules for the one terminal
 * frame it emits.
 */
export class TurnTerminal {
  /**
   * The stream produced its terminal result, or a generated terminal was
   * emitted. A stream that yields a result and THEN throws must not get a
   * second one.
   */
  sawResult = false;
  /**
   * Set when a startup check refused the turn before its prompt was
   * released, or when the turn failed for a named reason. It outranks the
   * abort it causes: the turn failed, it was not cancelled.
   */
  refused: TurnRefusal | null = null;
  /**
   * The gate decided not to release the prompt, for whatever reason. Once
   * set, nothing the stream says afterwards can turn the turn into a success.
   */
  withheld = false;
  worker: TurnTerminalWorker = {};
  /** The turn's terminal result, held until the worker has exited. */
  #held: ResultFrame | undefined;
  #sent = false;
  readonly #inputs: TurnTerminalInputs;

  constructor(inputs: TurnTerminalInputs) {
    this.#inputs = inputs;
  }

  wasCancelled(): boolean {
    return this.#inputs.hostSignal.aborted || (!this.refused && this.#inputs.abortController.signal.aborted);
  }

  /** Withhold the prompt: the turn's outcome is decided, and the SDK query stops. */
  withhold(): false {
    this.withheld = true;
    this.#inputs.abortController.abort();
    return false;
  }

  /** Hold the stream's terminal result until the worker has exited. */
  hold(frame: ResultFrame): void {
    this.sawResult = true;
    this.#held = frame;
    // Checked now and again at exit: the runtime may free space as it exits.
    this.worker.workerFailure?.();
  }

  /**
   * The runtime reports its outcome even when its transcript writes failed
   * on a full runtime-state tmpfs, and that output is then not saved
   * (#1625). So the state is checked when the result arrives, the terminal
   * result waits for the worker to exit and its state to be copied out, and
   * a state found full at either point names the turn
   * `worker_state_exceeded`. A refused copy-out names it
   * `worker_state_save_refused`, keeping its usage. A host cancellation still
   * outranks it.
   */
  unsaved(result: ResultFrame): ResultFrame {
    if (result.outcome === "cancelled" || this.#inputs.abortController.signal.aborted) return result;
    const failure = this.worker.workerFailure?.();
    if (failure?.errorClass !== FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded
      && failure?.errorClass !== FIRST_PARTY_FAILURE_CLASSES.worker_state_save_refused) return result;
    this.#inputs.frames.emit({ type: "error", code: "CLAUDE_ERROR", message: failure.message });
    return { ...result, outcome: "error", isError: true, failure };
  }

  /** Emit the held terminal result, once, after the worker has exited. */
  async release(): Promise<void> {
    if (!this.#held || this.#sent) return;
    this.#sent = true;
    // The worker's exit and copy-out must settle before the terminal frame.
    await this.worker.finishWorker?.().catch(() => {});
    const terminal = this.#held;
    // Cancellation can arrive after the SDK result, including while exit or
    // copy-out is pending. Keep its accounting, but discard error-only fields.
    // A startup refusal's own internal abort must remain a refusal.
    if (this.wasCancelled()) {
      const { failure: _failure, outcomeDetail: _detail, ...retained } = terminal;
      this.#inputs.frames.emit({ type: "status", status: "cancelled" });
      this.#inputs.frames.emit({ ...retained, outcome: "cancelled", isError: false });
    } else this.#inputs.frames.emit(this.unsaved(terminal));
  }

  /**
   * A worker whose runtime state refused or stopped the turn (#1625) ends it
   * with that named class rather than the runtime's own error.
   */
  workerRefusal(): boolean {
    const failure = this.refused ? undefined : this.worker.workerFailure?.();
    if (failure) this.refused = { code: "CLAUDE_ERROR", message: failure.message, failure };
    return Boolean(this.refused);
  }

  /**
   * Unified terminal frame for cancelled/failed turns. With a session
   * identity that is a `result`; WITHOUT one (an abort or failure before
   * the SDK reported a session) the contract's terminal is a bare `error`,
   * so a client keying on result/error is never left hanging.
   */
  async emitGenerated(outcome: "error" | "cancelled", diagnostic?: { code: string; message: string }): Promise<void> {
    if (this.sawResult) return;
    this.sawResult = true;
    const { frames } = this.#inputs;
    // Generated terminals obey the same cleanup boundary as SDK results.
    await this.worker.finishWorker?.().catch(() => {});
    if (this.wasCancelled()) outcome = "cancelled";
    if (outcome === "cancelled") frames.emit({ type: "status", status: "cancelled" });
    const reason = this.refused ?? diagnostic;
    if (frames.sessionId === null) {
      frames.emit(
        reason && outcome === "error"
          ? { type: "error", ...reason }
          : {
              type: "error",
              code: outcome === "cancelled" ? "CANCELLED" : "CLAUDE_ERROR",
              message:
                outcome === "cancelled"
                  ? "Turn cancelled before the session was established"
                  : "Turn failed before the session was established",
            }
      );
      return;
    }
    // The failure rides the terminal frame only, so a client never reports
    // it twice: here that is the result, not the diagnostic error.
    const failure = this.refused?.failure ?? this.#inputs.pendingFailure() ?? undefined;
    if (reason && outcome === "error") frames.emit({ type: "error", code: reason.code, message: reason.message });
    // costUsd deliberately absent (unknown); duration is real, numTurns 0 =
    // "no completed turns" for a turn that never finished.
    frames.emit({
      type: "result",
      sessionId: frames.sessionId,
      outcome,
      durationMs: Date.now() - this.#inputs.startedAt,
      numTurns: 0,
      isError: outcome === "error",
      ...(outcome === "error" && failure ? { failure } : {}),
    });
  }

  /**
   * The terminal for a turn whose stream ended or threw without its result:
   * a refusal fails it, a host cancellation outranks a state failure found
   * meanwhile, and anything else fails it with `fallback`'s reason.
   */
  async endUnfinished(fallback: () => { refusal?: TurnRefusal; diagnostic?: { code: string; message: string } }): Promise<void> {
    if (this.refused) {
      await this.emitGenerated("error");
    } else if (this.#inputs.abortController.signal.aborted) {
      await this.emitGenerated("cancelled");
    } else if (this.workerRefusal()) {
      await this.emitGenerated("error");
    } else {
      const { refusal, diagnostic } = fallback();
      if (refusal) this.refused = refusal;
      await this.emitGenerated("error", diagnostic);
    }
  }

  /**
   * The terminal for a turn that threw. error/cancelled frames are
   * diagnostics; the terminal frame is the result with an outcome (for turns
   * that have a session identity — a turn that died before any session id
   * ends on the bare error). Diagnostics only make sense BEFORE the terminal
   * frame; when the stream already delivered its result, the turn is over,
   * the late failure is swallowed and nothing may follow it.
   */
  async fail(caught: unknown, limits: Pick<WorkerLimitReporter, "failure">): Promise<void> {
    // The SDK reports a worker's deferred start failure as its own process
    // error; the worker's error names the turn, as when its spawn threw it (#2790).
    const err = this.worker.workerStartFailure?.() ?? caught;
    // A worker ended by a host limit fails the turn with that limit named (#1660).
    if (!this.sawResult && !this.refused && !this.#inputs.abortController.signal.aborted) this.refused = await limits.failure().catch(() => null);
    if (this.sawResult) await this.release();
    else await this.endUnfinished(() => thrownTurnFailure(err));
  }
}

/**
 * A failure of the turn's own failure handling inside the stream. It still
 * rejects startTurn, after cleanup, without being handled a second time.
 */
export class TurnFailureEscape {
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

export interface TurnTerminalInputs {
  frames: TurnFrames;
  /** The host's own cancellation signal. */
  hostSignal: AbortSignal;
  /** The turn's internal abort, which the SDK query listens to. */
  abortController: AbortController;
  startedAt: number;
  /** A failure the stream reported without its result. */
  pendingFailure(): TurnFailure | null | undefined;
}

/**
 * Why a turn that threw before its terminal result failed: the worker host's
 * or runtime state's named class, else the error itself as a diagnostic.
 */
export function thrownTurnFailure(err: unknown): { refusal?: TurnRefusal; diagnostic?: { code: string; message: string } } {
  const stateClass = workerStateClass(err);
  if (err instanceof WorkerHostError || err instanceof SessionTooLargeError || stateClass) {
    const { message } = err as Error;
    return { refusal: { code: "CLAUDE_ERROR", message,
      failure: { errorClass: stateClass ?? (err as WorkerHostError | SessionTooLargeError).errorClass, message } } };
  }
  return { diagnostic: { code: "CLAUDE_ERROR", message: err instanceof Error ? err.message : String(err) } };
}
