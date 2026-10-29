import { isRestoredConversationOutput } from "../voice/conversation-client.js";
import { rewriteTexts } from "./promoted-links.js";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatMessage, ChatState } from "../stores/chat-state.js";
import type { ConversationClientState, ConversationClientOutput } from "../voice/conversation-client.js";

export type TranscriptEntry =
  | { key: string; sessionId: string | null; kind: "message"; message: ChatMessage; index: number; section: "whole" | "progress" | "answer"; start?: number; end?: number }
  | { key: string; sessionId: string | null; kind: "speech"; output: ConversationClientOutput; restored: boolean };

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
  const textBefore = new Map<string, string>();
  const latest = new Map<string | null, string>();
  const segments = (key: string, text: string, sessionId: string | null, links?: Record<string, string>) => {
    const own = runs.get(key) ?? [];
    const old = textBefore.get(key) ?? "";
    if (text === old) return own;
    const length = text.length;
    textBefore.set(key, text);
    if (own.length && !text.startsWith(old)) {
      // Link promotion supplies exact edits. Other replacement snapshots have
      // no new arrival evidence: rebase the existing contiguous ranges in place.
      const rewrite = links ? rewriteTexts([old], links)[0] : undefined;
      let edits = rewrite?.text === text ? rewrite.edits : undefined;
      if (!edits) {
        let start = 0, suffix = 0;
        while (start < Math.min(old.length, length) && old[start] === text[start]) start++;
        while (suffix < Math.min(old.length, length) - start && old[old.length - suffix - 1] === text[length - suffix - 1]) suffix++;
        edits = [{ start, end: old.length - suffix, length: length - suffix - start }];
      }
      const rebase = (at: number) => {
        let shift = 0;
        for (const edit of edits) {
          if (edit.end <= at) shift += edit.length - (edit.end - edit.start);
          else if (edit.start < at) return edit.start + shift + edit.length;
          else break;
        }
        return at + shift;
      };
      for (const [index, run] of own.entries()) { run.start = index === 0 ? 0 : rebase(run.start); run.end = index === own.length - 1 ? length : rebase(run.end); }
      return own;
    }
    const tail = own.at(-1);
    if (length > (tail?.end ?? 0)) {
      if (tail && latest.get(sessionId) === tail.key) tail.end = length;
      else {
        const segment = { key: JSON.stringify([key, own.length]), start: tail?.end ?? 0, end: length };
        own.push(segment); position(segment.key); latest.set(sessionId, segment.key);
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
          if (!positions.has(key)) latest.set(sessionId, key);
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
          for (const run of segments(key, text, sessionId, message.linkRewrite?.links)) {
            entries.push({ kind: "message", sessionId, message, index, section: "answer", ...run });
          }
        } else add("whole");
      });
    }
    for (const output of voice.getState().outputs) {
      if (!output.generated) continue;
      const key = JSON.stringify(["speech", output.conversationId, output.epoch, output.outputId]);
      liveRuns.add(key);
      for (const run of segments(key, output.generated, output.sessionId)) {
        entries.push({ key: run.key, sessionId: output.sessionId, kind: "speech", restored: isRestoredConversationOutput(output), output: { ...output, generated: output.generated.slice(run.start, run.end) } });
      }
    }
    entries.sort((a, b) => position(a.key) - position(b.key));
    // Preserve positions across partial history chunks, but do not retain the
    // identities of evicted sessions/outputs for the lifetime of a mounted app.
    if (!buffers.some(([, buffer]) => buffer?.replay)) {
      const liveKeys = new Set(entries.map(e => e.key));
      for (const key of positions.keys()) if (!liveKeys.has(key)) positions.delete(key);
      for (const key of runs.keys()) if (!liveRuns.has(key)) { runs.delete(key); textBefore.delete(key); }
      for (const id of split) if (!liveMessages.has(id)) split.delete(id);
    }
    latest.clear();
    for (const entry of entries) latest.set(entry.sessionId, entry.key);
    state.setState({ entries });
  };
  // Changes in selection, timers and microphone state need no transcript scan.
  const stopChat = chat.subscribe((next, old) => {
    if (next.buffers !== old.buffers || next.draft !== old.draft || next.detachedDrafts !== old.detachedDrafts) sync();
  });
  const stopVoice = voice.subscribe((next, old) => { if (next.outputs !== old.outputs || next.active !== old.active || next.sessionId !== old.sessionId) sync(); });
  sync();
  return { state, dispose() { stopChat(); stopVoice(); positions.clear(); runs.clear(); split.clear(); latest.clear(); textBefore.clear(); state.setState({ entries: [] }); } };
}

/** Data-only display projections. Text ordinals stay intact for classified blocks. */
function projectTranscriptMessage(entry: Extract<TranscriptEntry, { kind: "message" }>): ChatMessage {
  const m = entry.message;
  if (entry.section === "whole") return m;
  if (entry.section === "answer") {
    const start = entry.start ?? 0, end = entry.end ?? Infinity;
    const parts = m.parts.filter(p => p.kind === "text");
    const offsets: number[] = [];
    let offset = 0;
    for (const part of parts) { offsets.push(offset); offset += part.text.length; }
    // Keep full source syntax and original block coordinates. Rendering selects
    // the arrival range after parsing, and assigns an indivisible block once.
    const blocks = m.blocks?.filter(block => {
      const at = offsets[block.partIndex];
      return at !== undefined && at + block.start >= start && at + block.start < end;
    });
    return {
      ...m, parts, content: parts.map(p => p.text).join(""), blocks, thinking: undefined,
      toolCalls: m.toolCalls, askUserExchanges: undefined, journal: undefined, journalLive: undefined,
      failure: undefined, retry: undefined,
    };
  }
  return {
    ...m, content: "", parts: m.parts.filter(p => p.kind !== "text"), blocks: undefined,
  };
}


const projections = new WeakMap<ChatMessage, Map<string, ChatMessage>>();
/** Keep memoized message bubbles stable when only another arrival changes. */
export function transcriptMessage(entry: Extract<TranscriptEntry, { kind: "message" }>): ChatMessage {
  if (entry.section === "whole") return entry.message;
  let own = projections.get(entry.message);
  if (!own) { own = new Map(); projections.set(entry.message, own); }
  const key = `${entry.section}:${entry.start}:${entry.end}`;
  let projected = own.get(key);
  if (!projected) { projected = projectTranscriptMessage(entry); own.set(key, projected); }
  return projected;
}


// Concrete display state is private to the chat store's root, not a new public
// connection API or a persisted transcript schema.
const timelines = new WeakMap<StoreApi<ChatState>, ReturnType<typeof createTranscriptTimeline>>();
export function transcriptTimelineFor(chat: StoreApi<ChatState>) {
  const timeline = timelines.get(chat);
  if (!timeline) throw new Error("Transcript timeline is not attached");
  return timeline;
}
export function attachTranscriptTimeline(chat: StoreApi<ChatState>, voice: StoreApi<ConversationClientState>) {
  const timeline = createTranscriptTimeline(chat, voice);
  timelines.set(chat, timeline);
  return { dispose() { timeline.dispose(); } };
}


export interface TranscriptRange {
  start: number;
  end: number;
  blocks?: ChatMessage["blocks"];
  /** Complete current answer for semantic actions; projections are display only. */
  source: ChatMessage;
}
const displayRanges = new WeakMap<ChatMessage, Map<string, TranscriptRange>>();
/** Stable private props preserve the message bubble's memoization contract. */
export function transcriptRange(entry: TranscriptEntry): TranscriptRange | undefined {
  if (entry.kind !== "message" || entry.section !== "answer") return;
  let own = displayRanges.get(entry.message);
  if (!own) { own = new Map(); displayRanges.set(entry.message, own); }
  const key = `${entry.start}:${entry.end}`;
  let range = own.get(key);
  if (!range) { range = { start: entry.start ?? 0, end: entry.end ?? Infinity, blocks: entry.message.blocks, source: entry.message }; own.set(key, range); }
  return range;
}
