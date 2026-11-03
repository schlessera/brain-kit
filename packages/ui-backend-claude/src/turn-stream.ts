import type { AccountInfo, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

import type { StreamAdapter } from "./stream-adapter.js";
import type { TurnInput } from "./turn-input.js";
import type { TurnLockBinding } from "./turn-lock.js";
import type { ReportActivity, WorkerLimitReporter } from "./turn-reporting.js";
import { TurnFailureEscape, type TurnFrames, type TurnTerminal } from "./turn-terminal.js";
import { assertClaudeRuntime, type claudeRuntimeRequirements } from "./version-requirements.js";

/**
 * How long a held result waits for the CLI to report reading a follow-up
 * before the input is closed anyway. The measured runtime reports it within
 * milliseconds; the bound only matters for a runtime that never reports it.
 */
export const FOLLOW_UP_ACK_GRACE_MS = 3_000;

export interface TurnStreamInputs {
  stream: AsyncIterable<SDKMessage>;
  input: TurnInput;
  adapter: StreamAdapter;
  frames: TurnFrames;
  terminal: TurnTerminal;
  req: Pick<StartTurnRequest, "sessionId" | "autonomous">;
  backendId: string;
  profileId: string;
  /** The account the CLI selected, for the per-turn runtime report. */
  account: Promise<AccountInfo | undefined>;
  reportActivity: ReportActivity;
  reportRuntime(claudeCodeVersion: string | undefined, apiKeySource: string | undefined, selected: AccountInfo | undefined): void;
  runtimeRequirements: ReturnType<typeof claudeRuntimeRequirements>;
  probedVersion: string | undefined;
  turnLock: TurnLockBinding;
  limits: WorkerLimitReporter;
  observeAnswerText: ((text: string) => void) | undefined;
  abortController: AbortController;
  /** Bounds how long a held result waits for a follow-up's read report; cleared at turn end. */
  ackGrace: { timer?: ReturnType<typeof setTimeout> };
  /** A new session's SDK-minted id: re-key the turn's slot and retain its observations. */
  adoptSessionId(sessionId: string): void;
}

/**
 * A `result` that follow-ups outlived (#1003): the CLI runs them as
 * continuation turns of the same process, so the one frame the client gets is
 * built from the LAST result, with the per-run counts of the earlier ones
 * added. The adapter tracks completed-response receipts across these
 * continuations; session-cumulative SDK totals are evidence only.
 */
export class CarriedResult {
  numTurns = 0;
  durationMs = 0;
  frames: ServerMessage[] = [];
  /** The continuation began: the held result no longer describes the turn. */
  continued = false;

  /** The frames of a result, with every earlier carried run's counts added. */
  static carry(carried: CarriedResult | null, frames: ServerMessage[]): ServerMessage[] {
    if (!carried) return frames;
    return frames.map((frame) =>
      frame.type === "result"
        ? { ...frame, numTurns: frame.numTurns + carried.numTurns, durationMs: frame.durationMs + carried.durationMs }
        : frame
    );
  }

  /** Whether `msg` begins the continuation turn. */
  static continues(msg: SDKMessage): boolean {
    return msg.type === "assistant" || msg.type === "user" || msg.type === "stream_event"
      || (msg.type === "system" && msg.subtype === "init");
  }
}

/**
 * Consume the SDK stream into the turn's frames, then settle its terminal.
 * Exactly one terminal frame per turn, whatever the stream does.
 */
export async function runTurnStream(inputs: TurnStreamInputs): Promise<void> {
  const { input, adapter, terminal } = inputs;
  let announced = false;
  let reported = false;
  let carried: CarriedResult | null = null;
  try {
    for await (const msg of inputs.stream) {
      input.observe(msg);
      if (carried && CarriedResult.continues(msg)) carried.continued = true;
      // A withheld turn has already decided its outcome; nothing the stream
      // does after that may replace it.
      if (terminal.withheld) break;
      // Emit session_info as soon as the session identity is known, before
      // any content frames (contract requirement).
      if (!announced && msg.session_id) {
        announced = true;
        announceSession(inputs, msg.session_id);
      }
      // After session_info, so the run is opened with its session.
      if (msg.type === "system" && msg.subtype === "init") {
        // Every continuation turn re-announces init; the run is reported once.
        if (!reported) inputs.reportRuntime(msg.claude_code_version, msg.apiKeySource, await inputs.account);
        reported = true;
        if (!initMatchesProbe(inputs, msg.claude_code_version)) break;
      }
      let frames = adapter.adapt(msg);
      if (msg.type === "result") {
        const { continues, unacknowledged } = input.settle();
        if (continues && !terminal.sawResult) {
          // Not the turn's last: hold it, in case no continuation comes.
          carried = holdContinued(carried, frames);
          // A follow-up the CLI has not reported reading may come from a
          // runtime that does not report it at all, and would then wait for
          // input forever. Closing is safe: what was pushed is still written,
          // and the CLI drains it before it exits. It waits a moment first,
          // because closing also refuses any later follow-up of this turn.
          if (unacknowledged) {
            clearTimeout(inputs.ackGrace.timer);
            inputs.ackGrace.timer = setTimeout(() => {
              if (input.unacknowledged()) input.close();
            }, FOLLOW_UP_ACK_GRACE_MS);
          }
          continue;
        }
        input.close();
        frames = CarriedResult.carry(carried, frames);
        carried = null;
      }
      forwardFrames(inputs, frames);
    }

    // A held result is the turn's terminal frame only if no continuation
    // began. One that began and ended without its own result is an abnormal
    // end, reported below like any other.
    if (carried && !carried.continued && !terminal.sawResult && !terminal.withheld && !inputs.abortController.signal.aborted) {
      for (const serverMsg of carried.frames) {
        if (serverMsg.type === "result") { terminal.hold(serverMsg); continue; }
        inputs.frames.emit(serverMsg);
      }
    }
    // The stream ended: release its held result, or end the turn without
    // one. Aborted → cancelled; not aborted → an abnormal end the client must
    // still be released from.
    await terminal.release();
    // A worker that never started ends the turn with its own error (#2790).
    const workerStartFailure = terminal.worker.workerStartFailure;
    if (!terminal.sawResult && workerStartFailure?.() !== undefined) throw workerStartFailure();
    if (!terminal.sawResult && !terminal.refused && !inputs.abortController.signal.aborted) terminal.refused = await inputs.limits.failure();
    else inputs.limits.reportCurrent();
    if (!terminal.sawResult) {
      await terminal.endUnfinished(() => ({
        diagnostic: { code: "CLAUDE_NO_RESULT", message: "Backend stream ended without a result" },
      }));
    }
  } catch (caught) {
    // The turn's failure is decided here, in the same microtask as the
    // stream's throw. A failure of that handling still rejects startTurn.
    try { await terminal.fail(caught, inputs.limits); }
    catch (error) { throw new TurnFailureEscape(error); }
  }
}

/** The session identity is known: scope the turn to it and announce it. */
function announceSession(inputs: TurnStreamInputs, streamSessionId: string): void {
  const { frames, req } = inputs;
  if (frames.sessionId === null) {
    // New session: adopt the SDK-minted id for scoping and re-key the busy
    // slot from its placeholder, so a resume of this session while it still
    // runs is detected as busy.
    frames.sessionId = streamSessionId;
    inputs.adoptSessionId(streamSessionId);
  }
  const sessionId = frames.sessionId;
  if (req.autonomous) {
    inputs.reportActivity({ kind: "autonomous_identity", runtimeSessionId: sessionId,
      backendId: inputs.backendId, profileId: inputs.profileId });
  } else {
    inputs.frames.emit({ type: "session_info", sessionId, isNew: !req.sessionId,
      providerId: inputs.profileId, backendId: inputs.backendId });
  }
}

/**
 * The running CLI must be the executable the probe verified. A mismatch
 * refuses the turn and withholds whatever the stream says next.
 */
function initMatchesProbe(inputs: TurnStreamInputs, version: string | undefined): boolean {
  const { runtimeRequirements, terminal } = inputs;
  if (!runtimeRequirements.length) return true;
  try {
    assertClaudeRuntime(version ?? null, runtimeRequirements, "system/init observation", "running CLI did not report its version");
    if (version !== inputs.probedVersion) throw new Error(`@schlessera/brain-backend-claude runtime (claude-code) during system/init observation; required probed identity ${inputs.probedVersion}; detected ${version}. The executable changed after verification; select an immutable compatible executable and retry.`);
    return true;
  } catch (error) {
    terminal.refused = { code: "CLAUDE_ERROR", message: error instanceof Error ? error.message : String(error) };
    terminal.withhold();
    return false;
  }
}

/** Hold a result that follow-ups may outlive, carrying every earlier run's counts. */
function holdContinued(carried: CarriedResult | null, frames: ServerMessage[]): CarriedResult | null {
  const held = CarriedResult.carry(carried, frames);
  const final = held.find((frame) => frame.type === "result");
  if (final?.type !== "result") return carried;
  const next = new CarriedResult();
  next.numTurns = final.numTurns;
  next.durationMs = final.durationMs;
  next.frames = held;
  return next;
}

/** Forward a message's frames; its result is held as the turn's terminal. */
function forwardFrames(inputs: TurnStreamInputs, frames: ServerMessage[]): void {
  const { terminal } = inputs;
  for (const serverMsg of frames) {
    // Exactly one terminal frame per turn, whatever the stream does:
    // a second SDK result is dropped rather than forwarded.
    if (serverMsg.type === "result") {
      if (terminal.sawResult) continue;
      terminal.hold(serverMsg);
      continue;
    }
    // Release the write lock the moment a mutating tool's result frame
    // lands (the turn-end backstop covers anything still held).
    if (serverMsg.type === "tool_result") {
      inputs.turnLock.releaseForTool(serverMsg.toolUseId);
      inputs.limits.reportCurrent();
    }
    if (serverMsg.type === "text_delta") inputs.observeAnswerText?.(serverMsg.text);
    inputs.frames.emit(serverMsg);
  }
}
