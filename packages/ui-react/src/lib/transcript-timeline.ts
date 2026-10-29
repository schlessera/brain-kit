import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatMessage, ChatState } from "../stores/chat-state.js";
import type { ConversationClientState, ConversationClientOutput } from "../voice/conversation-client.js";

export type TranscriptEntry =
  | { key: string; sessionId: string | null; kind: "message"; message: ChatMessage; index: number; section: "whole" | "progress" | "answer"; start?: number; end?: number }
  | { key: string; sessionId: string | null; kind: "speech"; output: ConversationClientOutput };

/**
 * Display order is first observation, not a clock or inferred voice/turn pairing.
 * Subscribe outside React so batched renders cannot reverse two received events.
 * Updates keep their slot. A task's status and its eventual words have separate
 * slots: starting work is not evidence that its answer already existed.
 * Historical batches retain their supplied order; no cross-stream historical
 * timing can be recovered from these records. This never modifies host history.
 */
export function createTranscriptTimeline(chat: StoreApi<ChatState>, voice: StoreApi<ConversationClientState>) {
  const state = createStore<{ entries: TranscriptEntry[] }>(() => ({ entries: [] }));
  let sequence = 0;
  const positions = new Map<string, number>();
  const position = (key: string) => {
    if (!positions.has(key)) positions.set(key, sequence++);
    return positions.get(key)!;
  };
  const split = new Set<string>();
  const runs = new Map<string, Array<{ key: string; start: number; end: number }>>();
  let latest = "";
  const segments = (key: string, length: number) => {
    const own = runs.get(key) ?? [];
    const tail = own.at(-1);
    if (length > (tail?.end ?? 0)) {
      if (tail && latest === tail.key) tail.end = length;
      else {
        const segment = { key: JSON.stringify([key, own.length]), start: tail?.end ?? 0, end: length };
        own.push(segment); position(segment.key); latest = segment.key;
      }
      runs.set(key, own);
    }
    return own;
  };
  const sync = () => {
    const entries: TranscriptEntry[] = [];
    const liveRuns = new Set<string>();
    const liveMessages = new Set<string>();
    const s = chat.getState();
    const v = voice.getState();
    const buffers = [...Object.entries(s.buffers), ...Object.entries(s.detachedDrafts), [null, s.draft]] as const;
    for (const [sessionId, buffer] of buffers) {
      let contextual = false;
      buffer?.messages.forEach((message, index) => {
        liveMessages.add(message.id);
        if (message.role === "user") contextual = message.source === "voice-context";
        const add = (section: "whole" | "progress" | "answer") => {
          const key = JSON.stringify(["message", message.id]);
          if (!positions.has(key)) latest = key;
          position(key);
          entries.push({ kind: "message", key, sessionId, message, index, section });
        };
        const speakingHere = v.active && v.sessionId === sessionId;
        const primary = JSON.stringify(["message", message.id]);
        if (message.role === "assistant" && (contextual || speakingHere && (!positions.has(primary) || !message.content))) split.add(message.id);
        if (split.has(message.id)) {
          add("progress");
          const text = message.parts.filter(p => p.kind === "text").map(p => p.text).join("");
          const key = JSON.stringify(["answer", message.id]);
          liveRuns.add(key);
          for (const run of segments(key, text.length)) {
            entries.push({ kind: "message", sessionId, message, index, section: "answer", ...run });
          }
        } else add("whole");
      });
    }
    for (const output of voice.getState().outputs) {
      if (!output.generated) continue;
      const key = JSON.stringify(["speech", output.conversationId, output.epoch, output.outputId]);
      liveRuns.add(key);
      for (const run of segments(key, output.generated.length)) {
        entries.push({ key: run.key, sessionId: output.sessionId, kind: "speech", output: { ...output, generated: output.generated.slice(run.start, run.end) } });
      }
    }
    entries.sort((a, b) => position(a.key) - position(b.key));
    // Preserve positions across partial history chunks, but do not retain the
    // identities of evicted sessions/outputs for the lifetime of a mounted app.
    if (!buffers.some(([, buffer]) => buffer?.replay)) {
      const liveKeys = new Set(entries.map(e => e.key));
      for (const key of positions.keys()) if (!liveKeys.has(key)) positions.delete(key);
      for (const key of runs.keys()) if (!liveRuns.has(key)) runs.delete(key);
      for (const id of split) if (!liveMessages.has(id)) split.delete(id);
    }
    state.setState({ entries });
  };
  // Changes in selection, timers and microphone state need no transcript scan.
  const stopChat = chat.subscribe((next, old) => {
    if (next.buffers !== old.buffers || next.draft !== old.draft || next.detachedDrafts !== old.detachedDrafts) sync();
  });
  const stopVoice = voice.subscribe((next, old) => { if (next.outputs !== old.outputs || next.active !== old.active || next.sessionId !== old.sessionId) sync(); });
  sync();
  return { state, dispose() { stopChat(); stopVoice(); positions.clear(); runs.clear(); split.clear(); } };
}

/** Data-only display projections. Text ordinals stay intact for classified blocks. */
export function transcriptMessage(entry: Extract<TranscriptEntry, { kind: "message" }>): ChatMessage {
  const m = entry.message;
  if (entry.section === "whole") return m;
  if (entry.section === "answer") {
    const start = entry.start ?? 0, end = entry.end ?? Infinity;
    let offset = 0;
    const blocks: NonNullable<ChatMessage["blocks"]> = [];
    const parts = m.parts.filter(p => p.kind === "text").map((p, partIndex) => {
      const from = Math.max(0, start - offset), to = Math.min(p.text.length, end - offset);
      offset += p.text.length;
      for (const block of m.blocks ?? []) if (block.partIndex === partIndex && block.start >= from && block.end <= to) {
        blocks.push({ ...block, start: block.start - from, end: block.end - from });
      }
      return { ...p, text: to > from ? p.text.slice(from, to) : "" };
    });
    return {
      ...m, parts, content: parts.map(p => p.text).join(""), blocks, thinking: undefined,
      toolCalls: [], askUserExchanges: undefined, journal: undefined, journalLive: undefined,
      failure: undefined, retry: undefined,
    };
  }
  return {
    ...m, content: "", parts: m.parts.filter(p => p.kind !== "text"), blocks: undefined,
  };
}
