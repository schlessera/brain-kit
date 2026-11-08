/**
 * The host's reader of one pi worker's protocol (#2517). Every frame is
 * validated before it is read; the reader binds the worker's identity and
 * transcript to this session, answers RPCs without blocking later frames and
 * settles the turn when the worker completes, refuses or breaks the protocol.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import type { LaunchedWorker, NativeFileVersions, sessionPromptContext, WorkerResourceLimitError } from "@schlessera/brain-ui-sdk/internal";

import type { CreatePiBackendOptions, SessionEnv } from "./backend-options.js";
import type { TurnContext } from "./turn-context.js";
import { pipeMessages, piWorkerMessage, PiInputSafetyUnavailableError, SessionTooLargeError } from "./worker-protocol.js";
import type { PiWorkerReceipts } from "./worker-receipts.js";
import type { PiWorkerRpc } from "./worker-rpc.js";
import type { provenToolExecution } from "./worker-session.js";

/** One worker session's mutable turn state, shared by its reader and its session handle. */
export interface PiWorkerTurnState {
  active: boolean;
  initialized: boolean;
  /** Revokes work; it does not confirm teardown. */
  ended: boolean;
  /** The turn's first failure: a later path cannot reclassify it. */
  error: Error | undefined;
  cost: number;
  thinkingLevel: ThinkingLevel | undefined;
  levels: ThinkingLevel[];
  model: Model<any> | undefined;
  /** The submitted prompt until the worker's transcript shows it delivered. */
  ownedPrompt: { id: string; text: string; images: boolean } | undefined;
}

export interface PiWorkerReader {
  child: LaunchedWorker;
  state: PiWorkerTurnState;
  ready: PromiseWithResolvers<void>;
  done: PromiseWithResolvers<void>;
  sessionId: string;
  backend: Pick<CreatePiBackendOptions, "brainPath" | "log">;
  startupStarted: number;
  promptContext: ReturnType<typeof sessionPromptContext> | undefined;
  sessionBudgetLimits: SessionEnv["sessionBudgetLimits"];
  autonomous: boolean;
  resumed: boolean;
  turnContext: TurnContext;
  nativeVersions: NativeFileVersions;
  receipts: PiWorkerReceipts;
  /** Entries saved before this turn. */
  resumedIds: ReadonlySet<unknown>;
  listeners: ReadonlySet<(event: AgentSessionEvent) => void>;
  /** Execution proof: a call's start, and the path its end proved, if any. */
  proof: { started(toolCallId: string): void; ended(toolName: string, toolCallId: string): ReturnType<typeof provenToolExecution> };
  toolExecution: SessionEnv["toolExecution"];
  dispatch(msg: PiWorkerRpc): Promise<unknown>;
  send(value: unknown): void;
  fail(reason: unknown): void;
  reportLimitHits(): void;
  limitEnded(): Promise<WorkerResourceLimitError | undefined>;
  diagnostic(): string;
}

/** Reads the worker's frames until its protocol closes; throws when it ends without completing. */
export async function readPiWorkerProtocol(reader: PiWorkerReader): Promise<void> {
  const { child, state, ready, done, sessionId, backend, startupStarted, promptContext, sessionBudgetLimits, autonomous, resumed,
    turnContext, nativeVersions, receipts, resumedIds, listeners, proof, toolExecution, dispatch, send, fail, reportLimitHits, limitEnded, diagnostic } = reader;
  for await (const raw of pipeMessages(child.stdout)) {
    const msg = piWorkerMessage.parse(raw);
    if (state.ended) throw new Error("Pi worker sent a message after turn completion");
    if (msg.type === "startup_timing") {
      backend.log?.("debug", "Pi startup phase", { phase: msg.phase, durationMs: msg.durationMs, elapsedMs: performance.now() - startupStarted });
    } else if (msg.type === "ready") {
      backend.log?.("debug", "Pi startup ready", { elapsedMs: performance.now() - startupStarted });
      if (msg.sessionId !== sessionId || state.initialized || state.active) throw new Error("Pi worker changed its server session identity");
      state.initialized = true;
      if (promptContext && msg.append !== undefined) promptContext.retainAppend(msg.append, sessionBudgetLimits ? { limits: sessionBudgetLimits } : {});
      state.model = msg.model as Model<any> | undefined;
      state.cost = msg.cost; state.thinkingLevel = msg.thinkingLevel as ThinkingLevel; state.levels = msg.levels as ThinkingLevel[];
      ready.resolve();
    } else if (msg.type === "prompt_prefix") {
      if (!state.active) throw new Error("Pi worker emitted a prefix outside the turn");
      if (!autonomous) {
        try { turnContext.bridge?.activity?.({ kind: "prompt_prefix", prefix: msg.prefix, resumed }); }
        catch { /* Observability must not fail the observed turn. */ }
      }
    } else if (msg.type === "rpc") {
      // Do not block reading: a bridge may wait for user input while other
      // sibling calls, cancellation and model frames need to flow.
      void dispatch(msg).then(value => {
        if (!state.ended) send({ type: "answer", id: msg.id, value });
      }, refusal => {
        const message = refusal instanceof Error ? refusal.message : String(refusal);
        turnContext.bridge?.emit({ type: "error", code: "PI_WORKER_RPC_REFUSED", message, sessionId });
        if (!state.ended) send({ type: "answer", id: msg.id, error: message });
      }).catch(fail);
    } else if (msg.type === "event") {
      if (!state.active) throw new Error("Pi worker emitted an event outside the turn");
      if (msg.event.type === "tool_execution_start") proof.started(msg.event.toolCallId);
      if (msg.event.type === "tool_execution_end") {
        reportLimitHits();
        const proven = proof.ended(msg.event.toolName, msg.event.toolCallId);
        if (proven) toolExecution?.(msg.event.toolCallId, proven);
        const receipt = receipts.applications.get(msg.event.toolCallId);
        if (receipt) {
          msg.event.result = receipt.output ? { content: receipt.output.content.map(part => ({ ...part })), details: receipt.output.details } : { content: [{ type: "text", text: JSON.stringify(receipt.result) }], details: receipt.result };
          msg.event.isError = !receipt.result.ok;
        }
      }
      for (const listener of listeners) listener(msg.event as AgentSessionEvent);
    } else if (msg.type === "snapshot") {
      if (!state.active) throw new Error("Pi worker sent transcript state outside the turn");
      const header = msg.entries[0];
      if (header?.type !== "session" || header.id !== sessionId || header.cwd !== backend.brainPath) {
        throw new Error("Pi worker sent an invalid transcript identity");
      }
      receipts.latestEntries = msg.entries;
      if (state.ownedPrompt) {
        for (const entry of receipts.latestEntries) {
          if (entry.type !== "message" || resumedIds.has(entry.id)) continue;
          const message = entry.message as { role?: string; content?: unknown } | undefined;
          const wire = Array.isArray(message?.content) ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : message?.content;
          // The installed runtime appends image-normalization hints after the
          // exact submitted text. Bind the full observed bytes to this owned
          // turn now; replay never strips a suffix or matches host patterns.
          const delivered = typeof wire === "string" && (wire === state.ownedPrompt.text
            || state.ownedPrompt.images && wire.startsWith(state.ownedPrompt.text + "\n\n"));
          if (message?.role === "user" && delivered && typeof entry.id === "string") {
            promptContext?.acknowledge(state.ownedPrompt.id, entry.id, wire as string);
            state.ownedPrompt = undefined;
            break;
          }
        }
      }
      receipts.persist();
    } else if (msg.type === "done") {
      if (!state.active) throw new Error("Pi worker completed an inactive turn");
      // Hits after the last tool step, or in a turn without one, still count.
      reportLimitHits();
      state.cost = msg.cost; nativeVersions.cancelPending(); state.ended = true;
      if (msg.error) done.reject(new Error(msg.error)); else done.resolve();
    } else throw msg.errorClass === "session_too_large" ? new SessionTooLargeError()
      :msg.errorClass === "input_safety_unavailable" ? new PiInputSafetyUnavailableError(new Error(msg.message)) : new BackendRequestError(msg.message);
  }
  if (!state.ended) throw (await limitEnded()) ?? new Error(`Pi worker exited before completion: ${diagnostic() || "protocol closed"}`);
}
