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
import { appendPiSession, savePiSession } from "./session-storage.js";
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
  /** What each receipt last retained, so an unchanged one is not written again (#4855). */
  const retained = new Map<string, { receipt: PiApplicationReceipt; anchor: string | null | undefined; output: string; isError: boolean }>();
  /**
   * What the session file holds after this turn's last save, by identity, and
   * its size (#4856). It can differ from `latestEntries`: it includes a
   * recovered result. Undefined until the first save, and after a failed one.
   */
  let saved: { entries: readonly unknown[]; bytes: number } | undefined;
  /** Recovered results by call id: a later recovery reuses the same entry. */
  const recovered = new Map<string, Record<string, unknown>>();
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
      const output = receipt.output?.content.filter(part => part.type === "text").map(part => part.text).join("") ?? JSON.stringify(receipt.result);
      const isError = !receipt.result.ok, last = retained.get(id);
      if (last?.receipt === receipt && last.anchor === receipt.anchor && last.output === output && last.isError === isError) continue;
      display.retainReceipt({ id, name: receipt.name, input: receipt.input, anchor: receipt.anchor, turnId: replayTurnId, output, isError });
      // Recorded only once written: a failed write is attempted again next time.
      retained.set(id, { receipt, anchor: receipt.anchor, output, isError });
    }
    if (!latestEntries.some(entry => entry.type === "message")) return;
    const next = [...latestEntries];
    if (recoverMissing) for (const [id, receipt] of applications) {
      const called = next.some(entry => !resumedIds.has(entry.id) && entry.type === "message" && (entry.message as any)?.role === "assistant"
        && (entry.message as any).content.some((part: any) => part.type === "toolCall" && part.id === id));
      const answered = next.some(entry => !resumedIds.has(entry.id) && entry.type === "message" && (entry.message as any)?.role === "toolResult"
        && (entry.message as any).toolCallId === id);
      if (!called || answered) continue;
      // The installed Pi adapter repairs orphaned calls with "No result provided".
      // Preserve the committed effect instead, only after the runtime has exited.
      let result = recovered.get(id);
      if (!result) recovered.set(id, result = { type: "message", id: randomUUID(), parentId: next.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: id, toolName: receipt.name,
          content: receipt.output?.content ?? [{ type: "text", text: JSON.stringify(receipt.result) }],
          isError: !receipt.result.ok, timestamp: Date.now() } });
      next.push(result);
    }
    // The file grows by lines only while the list extends what it holds;
    // anything else rewrites it whole, as before (#4856).
    const held = saved;
    if (held && held.entries.length <= next.length && held.entries.every((entry, index) => next[index] === entry)) {
      if (held.entries.length === next.length) return;
      const bytes = appendPiSession(sessionDir, sessionId, held.bytes, next.slice(held.entries.length));
      if (bytes !== undefined) { saved = { entries: next, bytes }; return; }
    }
    saved = undefined; // A failed rewrite leaves the file unknown: the next save rewrites it.
    saved = { entries: next, bytes: savePiSession(sessionDir, sessionId, next) };
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
