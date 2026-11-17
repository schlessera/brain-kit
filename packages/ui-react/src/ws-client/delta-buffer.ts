import type { ChatKey } from "../stores/chat-state.js";
import type { BrainUiServices } from "../root.js";

type DeltaKind = "text" | "thinking";

export interface DeltaBuffer {
  /** Queue a delta for the next frame; consecutive same-kind deltas merge. */
  enqueue(key: ChatKey, kind: DeltaKind, text: string): void;
  /** Apply every buffered delta, in arrival order, and clear the buffer. */
  flush(): void;
}

type PendingDelta = { kind: DeltaKind; text: string };

/**
 * Text and thinking deltas waiting to be applied, per buffer.
 *
 * A model streams tokens far faster than the display refreshes, and each socket
 * frame arrives in its own macrotask, so React cannot batch them: one token was
 * one store write, one render and one markdown re-parse of the growing message.
 * Coalescing a frame's worth of tokens into a single write costs nothing
 * visually — the screen could not have shown the intermediate states anyway.
 *
 * Consecutive same-kind chunks merge, so a burst of text becomes ONE appendText
 * rather than one per token. Kind changes start a new chunk, which is what keeps
 * interleaved thinking and text in their true chronological order.
 */
export function createDeltaBuffer(chat: BrainUiServices["stores"]["chat"]): DeltaBuffer {
  const pending = new Map<ChatKey, PendingDelta[]>();
  let flushScheduled = false;
  let frameId: number | undefined;

  function flush(): void {
    if (frameId !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
    frameId = undefined;
    flushScheduled = false;
    if (pending.size === 0) return;
    const batches = [...pending.entries()];
    pending.clear();
    const state = chat.getState();
    for (const [key, chunks] of batches) {
      for (const chunk of chunks) {
        if (chunk.kind === "text") state.appendText(key, chunk.text);
        else state.appendThinking(key, chunk.text);
      }
    }
  }

  function enqueue(key: ChatKey, kind: DeltaKind, text: string): void {
    const chunks = pending.get(key);
    if (!chunks) {
      pending.set(key, [{ kind, text }]);
    } else {
      const last = chunks[chunks.length - 1];
      if (last.kind === kind) last.text += text;
      else chunks.push({ kind, text });
    }
    // Outside a browser (unit tests, SSR) there is no frame to wait for, so apply
    // straight away and keep the handler's behaviour synchronous.
    if (typeof requestAnimationFrame !== "function") {
      flush();
      return;
    }
    if (!flushScheduled) {
      flushScheduled = true;
      frameId = requestAnimationFrame(flush);
    }
  }

  return { enqueue, flush };
}
