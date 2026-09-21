/**
 * The classification pass on one turn (D42 §1, §2, §4).
 *
 * A `TurnTextCollector` watches the frames the bridge relays and keeps the
 * assistant message's text parts the way the client will number them:
 * consecutive text deltas merge, a thinking delta or a tool call starts a
 * new part. After the turn's `result`, the collector's parts go to
 * `runClassificationPass`, which plans the request (nothing to ask means no
 * call), calls the classifier inside its budget, persists what came back,
 * and hands the blocks to the caller to emit — after the result, never
 * before, and never awaited by the turn.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type { Meter } from "@opentelemetry/api";
import type { MessageBlock, ServerMessage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { applyClassification, planClassification } from "@schlessera/brain-ui-sdk/server";

import { attachMessageBlocks, saveMessageBlocks } from "./blocks-store.js";
import type { JevClient, JevOutcome } from "./jev-client.js";

type PartKind = "text" | "thinking" | "tool";

/** Mirrors the client's `appendPart`: same-kind neighbours merge. */
export class TurnTextCollector {
  private parts: Array<{ kind: PartKind; text: string }> = [];

  observe(msg: ServerMessage): void {
    switch (msg.type) {
      case "text_delta":
        this.append("text", msg.text);
        break;
      case "thinking_delta":
        this.append("thinking", msg.text);
        break;
      case "tool_use_start":
        if (!msg.parentToolUseId) this.parts.push({ kind: "tool", text: "" });
        break;
      default:
        break;
    }
  }

  private append(kind: PartKind, text: string): void {
    const last = this.parts[this.parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.parts.push({ kind, text });
  }

  /** The text parts, in order, as the client numbers them. */
  textParts(): string[] {
    return this.parts.filter((part) => part.kind === "text").map((part) => part.text);
  }
}

export type PassOutcome = "skipped_no_candidates" | "swapped" | "kept" | JevOutcome;

export interface ClassificationPassDeps {
  jev: JevClient;
  db: () => Database;
  log: Logger;
  meter?: Meter;
}

export interface ClassificationPassRecord {
  outcome: PassOutcome;
  candidates: number;
  blocks: number;
  durationMs: number;
}

export interface TurnClassifier {
  readonly enabled: boolean;
  /**
   * Run the pass for one finished turn. Resolves to the blocks to emit, or
   * an empty list; never rejects. The caller does not await it on any path
   * that renders.
   */
  run(sessionId: string, textParts: readonly string[]): Promise<MessageBlock[]>;
  /**
   * Join persisted blocks onto a replayed history. Works without a key:
   * blocks classified while one was configured still replay after it is
   * removed.
   */
  attach(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[];
}

export function createTurnClassifier(deps: ClassificationPassDeps): TurnClassifier {
  const passes = deps.meter?.createCounter("classification.passes", {
    description: "Classification passes by outcome",
  });
  const latency = deps.meter?.createHistogram("classification.latency_ms", {
    description: "Wall time of the classifier call",
  });

  function record(sessionId: string, entry: ClassificationPassRecord): void {
    passes?.add(1, { outcome: entry.outcome });
    if (entry.outcome !== "skipped_no_candidates") latency?.record(entry.durationMs);
    deps.log.emit({
      severityText: entry.outcome === "swapped" || entry.outcome === "kept" || entry.outcome === "skipped_no_candidates" ? "INFO" : "WARN",
      body: "classification pass",
      attributes: {
        "session.id": sessionId,
        "classification.outcome": entry.outcome,
        "classification.candidates": entry.candidates,
        "classification.blocks": entry.blocks,
        "duration.ms": entry.durationMs,
      },
    });
  }

  return {
    enabled: deps.jev.enabled,
    attach(sessionId, messages) {
      try {
        return attachMessageBlocks(deps.db(), sessionId, messages);
      } catch (err) {
        deps.log.emit({
          severityText: "WARN",
          body: "classified blocks could not be joined onto history",
          attributes: {
            "session.id": sessionId,
            "error.message": err instanceof Error ? err.message : String(err),
          },
        });
        return messages;
      }
    },
    async run(sessionId, textParts) {
      if (!deps.jev.enabled) return [];
      try {
        const plan = planClassification(textParts);
        if (!plan) {
          record(sessionId, { outcome: "skipped_no_candidates", candidates: 0, blocks: 0, durationMs: 0 });
          return [];
        }
        const result = await deps.jev.classify(plan.request);
        if (!result.answers) {
          record(sessionId, {
            outcome: result.outcome,
            candidates: plan.candidates.length,
            blocks: 0,
            durationMs: result.durationMs,
          });
          return [];
        }
        const blocks = applyClassification(plan, result.answers);
        record(sessionId, {
          outcome: blocks.length ? "swapped" : "kept",
          candidates: plan.candidates.length,
          blocks: blocks.length,
          durationMs: result.durationMs,
        });
        if (blocks.length === 0) return [];
        // Persist per part, so replay joins by part text.
        const byPart = new Map<number, MessageBlock[]>();
        for (const block of blocks) {
          const list = byPart.get(block.partIndex) ?? [];
          list.push(block);
          byPart.set(block.partIndex, list);
        }
        for (const [partIndex, list] of byPart) {
          const text = textParts[partIndex];
          if (text !== undefined) saveMessageBlocks(deps.db(), sessionId, text, list);
        }
        return blocks;
      } catch (err) {
        // The pass is an enhancement: a failure here is a log line, never a
        // turn that renders worse.
        deps.log.emit({
          severityText: "WARN",
          body: "classification pass failed",
          attributes: {
            "session.id": sessionId,
            "error.message": err instanceof Error ? err.message : String(err),
          },
        });
        return [];
      }
    },
  };
}
