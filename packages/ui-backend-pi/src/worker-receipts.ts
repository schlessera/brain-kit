/**
 * Receipt persistence and replay for one pi worker session (#2517). The host
 * keeps every server-applied effect's receipt, anchors it to the transcript
 * the worker reports, saves that transcript and retains its display mappings
 * outside it. A committed effect whose call the runtime left unanswered is
 * recovered with its own result once the worker has exited.
 */
import { randomUUID } from "node:crypto";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import { createTurnTempPromoter, sessionReplay, WORKER_SCRATCH, type WorkerSandbox, type WorkerStateHandle } from "@schlessera/brain-ui-sdk/internal";

import type { CreatePiBackendOptions } from "./backend-options.js";
import type { createPiBridgeTools } from "./bridge-tools.js";
import { savePiSession } from "./session-storage.js";
import type { TurnContext } from "./turn-context.js";
import { PI_WORKER_STATE } from "./worker-protocol.js";

/** One server-applied effect: what the call asked, what the server answered and where it sits. */
export interface PiApplicationReceipt {
  name: string;
  input: Record<string, unknown>;
  result: BrainApplicationResult;
  anchor?: string | null;
  output?: Awaited<ReturnType<ReturnType<typeof createPiBridgeTools>[number]["execute"]>>;
}

export interface PiWorkerReceipts {
  /** Receipts by tool call id. */
  readonly applications: Map<string, PiApplicationReceipt>;
  /** The worker's latest reported transcript. */
  latestEntries: Record<string, unknown>[];
  /** Saves the receipts and the latest transcript; `recoverMissing` answers orphaned committed calls. */
  persist(recoverMissing?: boolean): void;
  /** The answer text of this turn's new assistant entries, as the worker has reported them. */
  answerText(): string;
  /** After the worker exits: persists, promotes what the answer links in turn temp, then closes it. */
  promote(worker: { turnTemp: WorkerStateHandle | undefined; sandbox: WorkerSandbox; closeTurnTemp(): Promise<void> }): Promise<void>;
}

export interface PiWorkerReceiptOptions {
  sessionDir: string;
  brainPath: string;
  sessionId: string;
  /** An autonomous turn saves no transcript and no answer. */
  autonomous: boolean;
  /** The resumed transcript, if any. */
  entries: FileEntry[] | undefined;
  /** Entries saved before this turn: only their own turn owns their display mappings. */
  resumedIds: Set<unknown>;
  turn: TurnContext;
  backend: Pick<CreatePiBackendOptions, "log">;
}

export function createPiWorkerReceipts(options: PiWorkerReceiptOptions): PiWorkerReceipts {
  const { sessionDir, brainPath, sessionId, autonomous, entries, resumedIds, turn: turnContext } = options;
  const replayTurnId = randomUUID();
  const display = sessionReplay(sessionDir, brainPath, sessionId);
  const applications = new Map<string, PiApplicationReceipt>();
  let latestEntries: Record<string, unknown>[] = [];
  function persist(recoverMissing = false): void {
    if (autonomous) return;
    // Receipt ownership survives even when no runtime call or snapshot exists.
    // Never synthesize a model call or replace a runtime-written result.
    for (const [id, receipt] of applications) {
      const called = latestEntries.find(entry => !resumedIds.has(entry.id) && entry.type === "message"
        && (entry.message as any)?.role === "assistant" && (entry.message as any).content.some((part: any) => part.type === "toolCall" && part.id === id));
      if (typeof called?.id === "string") receipt.anchor = called.id;
      else if (receipt.anchor === undefined) {
        // Direct effects can precede every native message. Null is an owned
        // session-root position, not an anchor to a later worker snapshot.
        const prior = latestEntries.findLast(entry => entry.type === "message")
          ?? entries?.findLast(entry => entry.type === "message");
        receipt.anchor = typeof prior?.id === "string" ? prior.id : null;
      }
      display.retainReceipt({ id, name: receipt.name, input: receipt.input, anchor: receipt.anchor, turnId: replayTurnId,
        output: receipt.output?.content.filter(part => part.type === "text").map(part => part.text).join("") ?? JSON.stringify(receipt.result),
        isError: !receipt.result.ok });
    }
    if (!latestEntries.some(entry => entry.type === "message")) return;
    const saved = [...latestEntries];
    if (recoverMissing) for (const [id, receipt] of applications) {
      const called = saved.some(entry => !resumedIds.has(entry.id) && entry.type === "message" && (entry.message as any)?.role === "assistant"
        && (entry.message as any).content.some((part: any) => part.type === "toolCall" && part.id === id));
      const answered = saved.some(entry => !resumedIds.has(entry.id) && entry.type === "message" && (entry.message as any)?.role === "toolResult"
        && (entry.message as any).toolCallId === id);
      if (!called || answered) continue;
      // The installed Pi adapter repairs orphaned calls with "No result provided".
      // Preserve the committed effect instead, only after the runtime has exited.
      saved.push({ type: "message", id: randomUUID(), parentId: saved.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: id, toolName: receipt.name,
          content: receipt.output?.content ?? [{ type: "text", text: JSON.stringify(receipt.result) }],
          isError: !receipt.result.ok, timestamp: Date.now() } });
    }
    savePiSession(sessionDir, sessionId, saved);
  }

  /**
   * Once the worker has exited, copies what this turn's answers link in turn
   * temp into scratch, retains display mappings outside the transcript, and reports each
   * linked file to the host (#1655). Turn temp is removed either way.
   */
  async function promote({ turnTemp, sandbox, closeTurnTemp }: Parameters<PiWorkerReceipts["promote"]>[0]): Promise<void> {
    try {
      persist(true);
      if (!turnTemp || autonomous) return;
      const promoter = createTurnTempPromoter({ brain: sandbox.brain, tmp: turnTemp.root, turnId: turnContext.turnId, scratch: WORKER_SCRATCH,
        exclude: [PI_WORKER_STATE], scratchWritable: sandbox.areas.some(area => area.name === "scratch" && area.mount.writable) });
      for (const entry of latestEntries) {
        if (entry.type !== "message" || resumedIds.has(entry.id)) continue;
        const message = entry.message as { role?: unknown; content?: unknown } | undefined;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const [index, part] of (message.content as Array<{ type?: unknown; text?: unknown }>).entries()) {
          if (part?.type !== "text" || typeof part.text !== "string") continue;
          await promoter.prepareRecovery(part.text, turnContext.signal ?? undefined);
          const next = promoter.rewrite(part.text);
          if (typeof entry.id === "string") display.retainText(entry.id, index, part.text, next);
        }
      }
      for (const record of promoter.records) {
        try { turnContext.bridge?.activity?.(record); } catch { /* Observability must not fail the observed turn. */ }
      }
    } catch (failure) {
      options.backend.log?.("warn", `promoting linked turn-temp files failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally { await closeTurnTemp(); }
  }
  function answerText(): string {
    const parts: string[] = [];
    for (const entry of latestEntries) {
      if (entry.type !== "message" || resumedIds.has(entry.id)) continue;
      const message = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content as Array<{ type?: unknown; text?: unknown }>) {
        if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
      }
    }
    return parts.join("\n");
  }
  return {
    applications,
    get latestEntries() { return latestEntries; },
    set latestEntries(next) { latestEntries = next; },
    persist, answerText, promote,
  };
}
