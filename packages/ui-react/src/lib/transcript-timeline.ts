import { recognitionIdentity, isRestoredConversationOutput } from "../voice/conversation-client.js";
import { rewriteTexts } from "./promoted-links.js";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatMessage, ChatState } from "../stores/chat-state.js";
import type { ConversationClientState, ConversationClientOutput, ConversationRecognition } from "../voice/conversation-client.js";

export type TranscriptEntry =
  | { key: string; sessionId: string | null; kind: "message"; message: ChatMessage; index: number; section: "whole" | "progress" | "answer"; start?: number; end?: number }
  | { key: string; sessionId: string | null; kind: "speech"; output: ConversationClientOutput; restored: boolean }
  | { key: string; sessionId: string | null; kind: "voice-boundary"; conversationId: string; epoch: number; label: "Voice ended" | "Voice reconnected" }
  | {key:string;sessionId:string|null;kind:"history-notice";label:string}
  | { key: string; sessionId: string | null; kind: "recognition"; fragments: ConversationRecognition[] };

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
  const positions = new Map<string, {arrival:number; afterHostSequence?:number}>();
  const position = (key: string, before?: string, afterHostSequence?:number) => {
    if (!positions.has(key)) {
      const successor = before === undefined ? undefined : positions.get(before)?.arrival;
      if (successor === undefined) positions.set(key, {arrival:sequence++,afterHostSequence});
      else {
        // A replay can prove a missing predecessor of an already drawn row
        // (for example the user of a peer's live answer). This is source order,
        // not a new arrival after that answer. Keep every existing key and its
        // relative place, inserting immediately before the known successor.
        // Integer ranks avoid fractional-position exhaustion on long histories.
        for (const [existing, at] of positions) if (at.arrival >= successor) positions.set(existing, {...at,arrival:at.arrival + 1});
        positions.set(key, {arrival:successor,afterHostSequence});
        sequence++;
      }
    }
    return positions.get(key)!.arrival;
  };
  const boundaries = new Map<string, Extract<TranscriptEntry, { kind: "voice-boundary" }>>();
  const split = new Set<string>();
  const runs = new Map<string, Array<{ key: string; start: number; end: number }>>();
  const textBefore = new Map<string, string>();
  const latest = new Map<string | null, string>();
  const segments = (key: string, text: string, sessionId: string | null, links?: Record<string, string>, afterHostSequence?:number) => {
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
        own.push(segment); position(segment.key,undefined,afterHostSequence); latest.set(sessionId, segment.key);
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
      const successors: Array<string | undefined> = [];
      let successor: string | undefined;
      for (let index = (buffer?.messages.length ?? 0) - 1; index >= 0; index--) {
        successors[index] = successor;
        const key = JSON.stringify(["message", buffer!.messages[index]!.id]);
        if (positions.has(key)) successor = key;
      }
      buffer?.messages.forEach((message, index) => {
        liveMessages.add(message.id);
        if (message.role === "user") contextual = message.source === "voice-context";
        const add = (section: "whole" | "progress" | "answer") => {
          const key = JSON.stringify(["message", message.id]);
          if (!positions.has(key) && !successors[index]) latest.set(sessionId, key);
          position(key, successors[index]);
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
    const emptyArchive: Array<{fragment:ConversationRecognition;sequence:number}> = [];
    const archive = Object.entries(v.dialogue ?? {}).flatMap(([key,page]) => page.records.map(record => ({record,restored:record.sequence <= (v.dialogueRestoredThrough?.[key] ?? -1),sessionId:page.sessionId ?? (v.profile?.historyOwnerId === page.ownerId ? v.sessionId : key)})));
    // The existing first-observation slot retains the durable prefix visible
    // when a transient tail arrived. Paging cannot move that tail before it.
    const observedPrefixes = new Map<string | null, number>();
    for (const {sessionId,record} of archive) {
      observedPrefixes.set(sessionId, Math.max(observedPrefixes.get(sessionId) ?? 0, record.sequence));
    }
    const observedThrough = (sessionId:string|null):number|undefined =>
      observedPrefixes.get(sessionId) ?? (v.active && v.sessionId===sessionId && v.profile?.historyOwnerId ? 0 : undefined);
    const archivedRecognition = new Set<string>();
    const archivedOutput = new Set<string>();
    const ordered = new Map<string,number>();
    const backendRanges = new Map<string, Array<{sequence:number; start:number; end:number; text:string}>>();
    for (const {record,sessionId,restored} of archive) {
      const e = record.evidence;
      if (e.kind === "voice") {
        const event = e.event;
        if (event.kind === "output_transcript") {
          archivedOutput.add(JSON.stringify([e.conversationId,e.epoch,event.outputId]));
          if (!event.text) continue;
          const key = `dialogue:${record.sequence}`;
          ordered.set(key,record.sequence);
          const liveOutput = !restored ? v.outputs.find(o=>o.conversationId===e.conversationId && o.epoch===e.epoch && o.outputId===event.outputId) : undefined;
          entries.push({key,sessionId,kind:"speech",restored,output:{...(liveOutput ?? {}),unsaved:undefined,unsavedGenerated:undefined,unsavedFragments:undefined,conversationId:e.conversationId,epoch:e.epoch,providerId:e.providerId,orderUnknown:false,outputId:event.outputId,generated:event.text,playback:liveOutput?.playback ?? "unknown",sessionId}});
        } else {
          const fragment: ConversationRecognition = {...event,conversationId:e.conversationId,epoch:e.epoch,providerId:e.providerId,sessionId,activation:e.epoch,contextual:true,restored,orderUnknown:false};
          const key = recognitionIdentity(fragment);
          archivedRecognition.add(key); ordered.set(key,record.sequence);
          if (event.text) entries.push({kind:"recognition",key,sessionId,fragments:[fragment]});
          else emptyArchive.push({fragment,sequence:record.sequence});
        }
      } else if (e.kind === "backend") {
        const key = JSON.stringify([sessionId,e.turnId]);
        const ranges = backendRanges.get(key) ?? []; ranges.push({sequence:record.sequence,...e}); backendRanges.set(key,ranges);
      } else if (e.kind === "request") {
        const matching = entries.filter(en => en.kind === "message" && en.sessionId === sessionId && (en.message.turnId === e.turnId || en.message.streamTurnId === e.turnId || e.requestId && en.message.requestId === e.requestId));
        const hasRanges = archive.some(item=>item.sessionId===sessionId && item.record.evidence.kind === "backend" && item.record.evidence.turnId===e.turnId);
        if (hasRanges) for (const entry of matching) {
          if (entry.kind === "message" && entry.section !== "answer") ordered.set(entry.key,record.sequence);
        }
        else if (matching.some(en=>en.kind === "message" && en.message.role === "assistant" && !en.message.isStreaming) && !entries.some(en=>en.key===`dialogue-gap:${sessionId}`)) entries.push({key:`dialogue-gap:${sessionId}`,sessionId,kind:"history-notice",label:"Original discussion position unknown."});
      }
    }
    // A range is only a position witness for exact backend-owned text. Never
    // render its copy as an independent answer or rewrite a native transcript.
    for (const [key,ranges] of backendRanges) {
      const [sid,turnId] = JSON.parse(key) as [string,string];
      const messageEntry = entries.find(en => en.kind === "message" && en.sessionId === sid && en.message.role === "assistant" && (en.message.turnId === turnId || en.message.streamTurnId === turnId));
      if (!messageEntry || messageEntry.kind !== "message") {
        if (buffers.some(([key,buffer])=>key===sid && buffer?.isStreaming)) continue;
        const gapKey=`dialogue-gap:${sid}`;
        if (!entries.some(e=>e.key===gapKey)) entries.push({key:gapKey,sessionId:sid,kind:"history-notice",label:"Original discussion position unknown."});
        continue;
      }
      if (messageEntry.message.isStreaming) continue;
      const text = messageEntry.message.parts.filter(p => p.kind === "text").map(p => p.text).join("");
      const byOffset = [...ranges].sort((a,b)=>a.start-b.start);
      const complete = byOffset[0]?.start === 0 && byOffset.at(-1)?.end === text.length
        && byOffset.every((r,i)=>i===0 || byOffset[i-1]!.end === r.start);
      if (!complete || !ranges.every(r => text.slice(r.start,r.end) === r.text)) {
        // A page or a failed witness write must never truncate the native answer.
        // Keep the complete native source group together, with unknown cross-stream order.
        const requestIds = new Set(archive.flatMap(item=>item.sessionId===sid && item.record.evidence.kind === "request" && item.record.evidence.turnId===turnId ? [item.record.evidence.requestId] : []));
        for (const entry of entries) if (entry.kind === "message" && entry.sessionId === sid && (entry.message.turnId===turnId || entry.message.streamTurnId===turnId || entry.message.requestId && requestIds.has(entry.message.requestId))) ordered.delete(entry.key);
        if (!entries.some(en=>en.key===`dialogue-gap:${sid}`)) entries.push({key:`dialogue-gap:${sid}`,sessionId:sid,kind:"history-notice",label:"Original discussion position unknown."}); continue;
      }
      for (let i=entries.length-1;i>=0;i--) if (entries[i]!.kind === "message" && (entries[i] as Extract<TranscriptEntry,{kind:"message"}>).message === messageEntry.message && (entries[i] as Extract<TranscriptEntry,{kind:"message"}>).section !== "progress") entries.splice(i,1);
      if (!entries.some(en=>en.kind === "message" && en.message === messageEntry.message)) entries.push({...messageEntry,section:"progress"});
      for (const r of ranges) {
        const arrivalKey = `dialogue:${r.sequence}`; ordered.set(arrivalKey,r.sequence);
        entries.push({...messageEntry,key:arrivalKey,section:"answer",start:r.start,end:r.end});
      }
    }
    for (const output of voice.getState().outputs) {
      if (archivedOutput.has(JSON.stringify([output.conversationId,output.epoch,output.outputId])) && !output.unsavedGenerated) continue;
      const generated=output.unsavedGenerated ?? output.generated;
      if (!generated) continue;
      const key = JSON.stringify([output.unsavedGenerated ? "unsaved-speech" : "speech", output.conversationId, output.epoch, output.outputId]);
      liveRuns.add(key);
      for (const run of segments(key, generated, output.sessionId,undefined,observedThrough(output.sessionId))) {
        entries.push({ key: run.key, sessionId: output.sessionId, kind: "speech", restored: !output.unsavedGenerated && isRestoredConversationOutput(output), output: { ...output, generated: generated.slice(run.start, run.end), ...(output.unsavedGenerated ? {playback:"unknown" as const,unsaved:true as const,orderUnknown:false} : {}) } });
      }
    }
    // Preserve actual fragment identities before projection. Provider intervals
    // and equal text never determine order or captured-input ownership.
    const empty: ConversationRecognition[] = [];
    for (const fragment of v.recognition) {
      const key = recognitionIdentity(fragment);
      if (archivedRecognition.has(key)) continue;
      position(key,undefined,observedThrough(fragment.sessionId));
      if (!fragment.text && !fragment.moved) { empty.push(fragment); continue; }
      entries.push({ kind: "recognition", key, sessionId: fragment.sessionId, fragments: [fragment] });
    }
    for (const [key, boundary] of boundaries) {
      const recognition = v.recognition.find(f => f.conversationId === boundary.conversationId && f.epoch === boundary.epoch);
      const output = v.outputs.find(o => o.conversationId === boundary.conversationId && o.epoch === boundary.epoch);
      if (!recognition && !output && !(v.active && v.profile?.conversationId === boundary.conversationId && v.profile.epoch === boundary.epoch)) { boundaries.delete(key); continue; }
      // Adoption moves source ownership, never the boundary's identity/rank.
      boundary.sessionId = recognition?.sessionId ?? output?.sessionId ?? boundary.sessionId;
      entries.push(boundary);
    }
    const rank = (key:string):readonly number[] => {
      const durable=ordered.get(key); if(durable!==undefined)return [durable,0,0];
      const at=position(key), anchor=positions.get(key)?.afterHostSequence;
      return anchor === undefined ? [-1,0,at] : [anchor,1,at];
    };
    const compareKeys=(a:string,b:string) => {const x=rank(a),y=rank(b);return x[0]!-y[0]! || x[1]!-y[1]! || x[2]!-y[2]!;};
    entries.sort((a, b) => compareKeys(a.key,b.key));
    const stream = (f: ConversationRecognition) => JSON.stringify([f.conversationId, f.epoch, f.kind, f.kind === "input_fragment" ? f.utteranceId : null, !!f.unsaved]);
    const grouped: TranscriptEntry[] = [];
    const members = new Map<TranscriptEntry, Set<string>>();
    for (const entry of entries) {
      const tail = grouped.at(-1);
      if (entry.kind === "recognition" && tail?.kind === "recognition" && stream(entry.fragments[0]!) === stream(tail.fragments[0]!)) { tail.fragments.push(...entry.fragments); members.get(tail)!.add(entry.key); }
      else if (entry.kind === "speech" && tail?.kind === "speech" && entry.sessionId === tail.sessionId && entry.output.conversationId === tail.output.conversationId && entry.output.epoch === tail.output.epoch && entry.output.outputId === tail.output.outputId && entry.restored === tail.restored && entry.output.unsaved === tail.output.unsaved) { tail.output = {...tail.output,generated:tail.output.generated+entry.output.generated}; members.get(tail)!.add(entry.key); }
      else if (entry.kind === "message" && entry.section === "answer" && tail?.kind === "message" && tail.section === "answer" && entry.message === tail.message && tail.end === entry.start) { tail.end=entry.end; members.get(tail)!.add(entry.key); }
      else { grouped.push(entry); members.set(entry,new Set([entry.key])); }
    }
    for (const {fragment,sequence} of emptyArchive) {
      const own = grouped.findLast(e=>e.kind === "recognition" && stream(e.fragments[0]!) === stream(fragment) && (ordered.get(e.key) ?? Infinity) < sequence);
      if (own?.kind === "recognition") own.fragments.push(fragment);
    }
    // Finish-only evidence belongs in details, never an empty speech bubble or
    // a new arrival slot. Keep it with the most recent retained matching source.
    for (const fragment of empty) {
      const own = grouped.findLast(e => e.kind === "recognition" && stream(e.fragments[0]!) === stream(fragment) && position(e.key) < position(recognitionIdentity(fragment)));
      if (own?.kind === "recognition") own.fragments.push(fragment);
    }
    for (const entry of grouped) if (entry.kind === "recognition") entry.fragments.sort((a, b) => compareKeys(recognitionIdentity(a),recognitionIdentity(b)));
    // A page can prepend members of a contiguous blurb. Keep an existing
    // canonical member as its DOM key while that exact source still survives.
    // Membership comes only from this projection; it creates no extra order.
    const previous = new Map(state.getState().entries.map((entry,index)=>[entry.key,{entry,index}]));
    for (const entry of grouped) {
      let surviving: {entry:TranscriptEntry;index:number}|undefined;
      for (const key of members.get(entry)!) {
        const old=previous.get(key);
        if (old && old.entry.kind===entry.kind && old.entry.sessionId===entry.sessionId && (!surviving || old.index<surviving.index)) surviving=old;
      }
      if (surviving) entry.key=surviving.entry.key;
    }
    // Preserve positions across partial history chunks, but do not retain the
    // identities of evicted sessions/outputs for the lifetime of a mounted app.
    if (!buffers.some(([, buffer]) => buffer?.replay)) {
      const liveKeys = new Set([...entries.map(e => e.key), ...empty.map(recognitionIdentity)]);
      for (const key of positions.keys()) if (!liveKeys.has(key)) positions.delete(key);
      for (const key of runs.keys()) if (!liveRuns.has(key)) { runs.delete(key); textBefore.delete(key); }
      for (const id of split) if (!liveMessages.has(id)) split.delete(id);
    }
    latest.clear();
    for (const entry of entries) latest.set(entry.sessionId, entry.key);
    state.setState({ entries: grouped });
  };
  // Changes in selection, timers and microphone state need no transcript scan.
  const stopChat = chat.subscribe((next, old) => {
    if (next.buffers !== old.buffers || next.draft !== old.draft || next.detachedDrafts !== old.detachedDrafts) sync();
  });
  const stopVoice = voice.subscribe((next, old) => {
    if (old.profile && old.active && (!next.active || next.profile && next.profile.conversationId === old.profile.conversationId && next.profile.epoch > old.profile.epoch)) {
      const reconnect = next.active && next.profile;
      const profile = reconnect || old.profile;
      const key = JSON.stringify(["voice-boundary", profile.conversationId, profile.epoch, sequence]);
      position(key); latest.set(next.sessionId, key);
      boundaries.set(key, { kind: "voice-boundary", key, sessionId: next.sessionId, conversationId: profile.conversationId, epoch: profile.epoch, label: reconnect ? "Voice reconnected" : "Voice ended" });
    }
    if (next.profile !== old.profile || next.recognition !== old.recognition || next.outputs !== old.outputs || next.active !== old.active || next.sessionId !== old.sessionId || next.dialogue !== old.dialogue) sync(); });
  sync();
  return { state, dispose() { stopChat(); stopVoice(); positions.clear(); boundaries.clear(); runs.clear(); split.clear(); latest.clear(); textBefore.clear(); state.setState({ entries: [] }); } };
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
