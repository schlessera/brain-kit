import { recognitionIdentity, isRestoredConversationOutput } from "../voice/conversation-client.js";
import { rewriteTexts } from "./promoted-links.js";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatMessage, ChatState } from "../stores/chat-state.js";
import type { ConversationClientState, ConversationClientOutput, ConversationRecognition } from "../voice/conversation-client.js";
import type { DialogueRecord } from "@schlessera/brain-ui-sdk/protocol";

export type TranscriptEntry =
  | { key: string; sessionId: string | null; kind: "message"; message: ChatMessage; index: number; section: "whole" | "progress" | "answer"; start?: number; end?: number }
  | { key: string; sessionId: string | null; kind: "speech"; output: ConversationClientOutput; restored: boolean;
      /** Set only on a reply's last segment, and only from a retained interruption naming its output. */
      cutOff?: true }
  | { key: string; sessionId: string | null; kind: "voice-boundary"; conversationId: string; epoch: number; label: "Voice ended" | "Voice reconnected";
      /** From the retained end's host clock span. "Voice ended" comes only from retained evidence, so live and reloaded chats agree. */
      durationMs?: number }
  | {key:string;sessionId:string|null;kind:"history-notice";label:string}
  /** R2 (#3699): the startup-context coverage of one live conversation, at the start of its live section, when it names a sent count or is incomplete. */
  | { key: string; sessionId: string | null; kind: "voice-coverage"; conversationId: string; coverage: NonNullable<NonNullable<ConversationClientState["profile"]>["historyCoverage"]> }
  | { key: string; sessionId: string | null; kind: "recognition"; fragments: ConversationRecognition[] };

type MessageEntry = Extract<TranscriptEntry, { kind: "message" }>;
type BoundaryEntry = Extract<TranscriptEntry, { kind: "voice-boundary" }>;
type CoverageEntry = Extract<TranscriptEntry, { kind: "voice-coverage" }>;
type SessionKey = string | null;
type SessionBuffer = ChatState["draft"] | undefined;
type ArchiveItem = {
  record: DialogueRecord; restored: boolean; sessionId: SessionKey;
  /** A retained recognition record, as the fragment the live list would hold. */
  fragment?: ConversationRecognition;
  /** The live output a retained, not restored reply reads its playback from. */
  liveOutput?: ConversationClientOutput;
};
/** The voice inputs that name one session, with every cross-session fact they read. */
interface VoiceInputs {
  archive: ArchiveItem[]; outputs: ConversationClientOutput[]; recognition: ConversationRecognition[];
  boundaries: BoundaryEntry[]; coverages: CoverageEntry[];
  /** Compared by identity, item by item: equal means the session's voice passes read the same values. */
  signature: unknown[];
}
/** One session's projection and the inputs it was computed from. */
interface Projection {
  buffers: SessionBuffer[]; speaking: boolean; owner: boolean; voice: VoiceInputs;
  entries: TranscriptEntry[]; keys: Set<string>; runs: Set<string>; messages: Set<string>;
}
const NO_VOICE: VoiceInputs = { archive: [], outputs: [], recognition: [], boundaries: [], coverages: [], signature: [] };
const NO_ENTRIES: TranscriptEntry[] = [];
const sameItems = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((item, index) => item === b[index]);
const outputIdentity = (conversationId: string, epoch: number, outputId: string) => JSON.stringify([conversationId, epoch, outputId]);

/**
 * Keys that at least one session's projection holds. A new or released key is
 * dropped at the next sweep once no session holds it, so a sweep visits only
 * the keys that may have stopped being live, never every retained key.
 */
function liveness(drop: (key: string) => void) {
  const held = new Map<string, number>();
  const stale = new Set<string>();
  return {
    hold(keys: Iterable<string>) { for (const key of keys) held.set(key, (held.get(key) ?? 0) + 1); },
    release(keys: Iterable<string>) {
      for (const key of keys) { const count = held.get(key)! - 1; if (count) held.set(key, count); else held.delete(key); stale.add(key); }
    },
    touch(key: string) { stale.add(key); },
    sweep() { for (const key of stale) if (!held.has(key)) drop(key); stale.clear(); },
    clear() { held.clear(); stale.clear(); },
  };
}

/**
 * Display order is first observation, not a clock or inferred voice/turn pairing.
 * Subscribe outside React so batched renders cannot reverse two received events.
 * Updates keep their slot. A task's status and its eventual words have separate
 * slots: starting work is not evidence that its answer already existed.
 * Historical batches retain their supplied order; no cross-stream historical
 * timing can be recovered from these records. This never modifies host history.
 *
 * The projection is kept per session (#4741). A session is projected again
 * only when a buffer field it reads (`messages`, `isStreaming`) or a voice
 * input naming it changed; every other session keeps its entries and its
 * array, and a write that changes no session publishes nothing. Arrival
 * positions stay one shared, order-preserving numbering, so a session's order
 * is the same as in one projection over every session.
 */
export function createTranscriptTimeline(chat: StoreApi<ChatState>, voice: StoreApi<ConversationClientState>) {
  const state = createStore<{ entries: TranscriptEntry[]; sessions: ReadonlyMap<SessionKey, TranscriptEntry[]> }>(() => ({ entries: [], sessions: new Map() }));
  let sequence = 0;
  const positions = new Map<string, {arrival:number; afterHostSequence?:number}>();
  const runs = new Map<string, Array<{ key: string; start: number; end: number }>>();
  const textBefore = new Map<string, string>();
  const split = new Set<string>();
  const messageKeys = new Map<string, string>();
  const livePositions = liveness(key => positions.delete(key));
  const liveRuns = liveness(key => { if (runs.has(key)) { runs.delete(key); textBefore.delete(key); } });
  const liveMessages = liveness(id => { split.delete(id); messageKeys.delete(id); });
  const position = (key: string, before?: string, afterHostSequence?:number) => {
    if (!positions.has(key)) {
      livePositions.touch(key);
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
  /** One key string per message id, made once and kept while the id is live. */
  const messageKey = (id: string) => {
    let key = messageKeys.get(id);
    if (key === undefined) messageKeys.set(id, key = JSON.stringify(["message", id]));
    return key;
  };
  const boundaries = new Map<string, BoundaryEntry>();
  const coverages = new Map<string, CoverageEntry>();
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

  // Facts every session's voice passes share: which sources the retained
  // dialogue already holds, and which replies it records as interrupted.
  let archivedRecognition = new Set<string>();
  let archivedOutput = new Set<string>();
  let interrupted = new Set<string>();
  /** Split the voice state by the session each input names. Reads only voice state. */
  const partition = (v: ConversationClientState) => {
    const parts = new Map<SessionKey, VoiceInputs>();
    const own = (sessionId: SessionKey) => {
      let part = parts.get(sessionId);
      if (!part) parts.set(sessionId, part = { archive: [], outputs: [], recognition: [], boundaries: [], coverages: [], signature: [] });
      return part;
    };
    archivedRecognition = new Set(); archivedOutput = new Set(); interrupted = new Set();
    for (const [key, page] of Object.entries(v.dialogue ?? {})) for (const record of page.records) {
      const sessionId = page.sessionId ?? (v.profile?.historyOwnerId === page.ownerId ? v.sessionId : key);
      const item: ArchiveItem = { record, restored: record.sequence <= (v.dialogueRestoredThrough?.[key] ?? -1), sessionId };
      const e = record.evidence;
      if (e.kind === "voice_interruption") { if (e.outputId) interrupted.add(outputIdentity(e.conversationId,e.epoch,e.outputId)); }
      else if (e.kind === "voice") {
        const event = e.event;
        if (event.kind === "output_transcript") {
          archivedOutput.add(outputIdentity(e.conversationId,e.epoch,event.outputId));
          if (event.text && !item.restored) item.liveOutput = v.outputs.find(o=>o.conversationId===e.conversationId && o.epoch===e.epoch && o.outputId===event.outputId);
        } else {
          item.fragment = {...event,conversationId:e.conversationId,epoch:e.epoch,providerId:e.providerId,sessionId,activation:e.epoch,contextual:true,restored:item.restored,orderUnknown:false};
          archivedRecognition.add(recognitionIdentity(item.fragment));
        }
      }
      own(sessionId).archive.push(item);
    }
    for (const output of v.outputs) own(output.sessionId).outputs.push(output);
    for (const fragment of v.recognition) own(fragment.sessionId).recognition.push(fragment);
    for (const [key, boundary] of boundaries) {
      const recognition = v.recognition.find(f => f.conversationId === boundary.conversationId && f.epoch === boundary.epoch);
      const output = v.outputs.find(o => o.conversationId === boundary.conversationId && o.epoch === boundary.epoch);
      if (!recognition && !output && !(v.active && v.profile?.conversationId === boundary.conversationId && v.profile.epoch === boundary.epoch)) { boundaries.delete(key); continue; }
      // Adoption moves source ownership, never the boundary's identity/rank.
      boundary.sessionId = recognition?.sessionId ?? output?.sessionId ?? boundary.sessionId;
      own(boundary.sessionId).boundaries.push(boundary);
    }
    for (const [key, notice] of coverages) {
      const recognition = v.recognition.find(f => f.conversationId === notice.conversationId);
      const output = v.outputs.find(o => o.conversationId === notice.conversationId);
      if (!recognition && !output && !(v.active && v.profile?.conversationId === notice.conversationId)) { coverages.delete(key); continue; }
      notice.sessionId = recognition?.sessionId ?? output?.sessionId ?? notice.sessionId;
      own(notice.sessionId).coverages.push(notice);
    }
    for (const part of parts.values()) {
      for (const item of part.archive) {
        const e = item.record.evidence;
        part.signature.push(item.record, item.restored, item.liveOutput);
        if (e.kind === "voice" && e.event.kind === "output_transcript") part.signature.push(interrupted.has(outputIdentity(e.conversationId,e.epoch,e.event.outputId)));
      }
      for (const output of part.outputs) {
        const id = outputIdentity(output.conversationId,output.epoch,output.outputId);
        part.signature.push(output, archivedOutput.has(id), interrupted.has(id));
      }
      for (const fragment of part.recognition) part.signature.push(fragment, archivedRecognition.has(recognitionIdentity(fragment)));
      part.signature.push(...part.boundaries, ...part.coverages);
    }
    return parts;
  };

  /** Project one session. Reads only its own buffers and the voice inputs naming it. */
  const project = (sessionId: SessionKey, buffers: SessionBuffer[], inputs: VoiceInputs, v: ConversationClientState, previousEntries: readonly TranscriptEntry[]) => {
    const entries: TranscriptEntry[] = [];
    const ownRuns = new Set<string>();
    const ownMessages = new Set<string>();
    const speakingHere = v.active && v.sessionId === sessionId;
    for (const buffer of buffers) {
      let contextual = false;
      const messages = buffer?.messages ?? [];
      const keys = messages.map(message => messageKey(message.id));
      const successors: Array<string | undefined> = [];
      let successor: string | undefined;
      for (let index = messages.length - 1; index >= 0; index--) {
        successors[index] = successor;
        if (positions.has(keys[index]!)) successor = keys[index];
      }
      messages.forEach((message, index) => {
        ownMessages.add(message.id);
        if (message.role === "user") contextual = message.source === "voice-context";
        const primary = keys[index]!;
        const add = (section: "whole" | "progress" | "answer") => {
          if (!positions.has(primary) && !successors[index]) latest.set(sessionId, primary);
          position(primary, successors[index]);
          entries.push({ kind: "message", key: primary, sessionId, message, index, section });
        };
        if (message.role === "assistant" && (contextual || speakingHere && (!positions.has(primary) || !message.content))) { split.add(message.id); }
        if (split.has(message.id)) {
          add("progress");
          const text = message.parts.filter(p => p.kind === "text").map(p => p.text).join("");
          const key = JSON.stringify(["answer", message.id]);
          ownRuns.add(key);
          for (const run of segments(key, text, sessionId, message.linkRewrite?.links)) {
            entries.push({ kind: "message", sessionId, message, index, section: "answer", ...run });
          }
        } else add("whole");
      });
    }
    const emptyArchive: Array<{fragment:ConversationRecognition;sequence:number}> = [];
    const archive = inputs.archive;
    // The existing first-observation slot retains the durable prefix visible
    // when a transient tail arrived. Paging cannot move that tail before it.
    let observedPrefix: number | undefined;
    for (const {record} of archive) observedPrefix = Math.max(observedPrefix ?? 0, record.sequence);
    const observedThrough = observedPrefix ?? (speakingHere && v.profile?.historyOwnerId ? 0 : undefined);
    const ordered = new Map<string,number>();
    const backendRanges = new Map<string, Array<{sequence:number; start:number; end:number; text:string}>>();
    for (const {record,restored,fragment,liveOutput} of archive) {
      const e = record.evidence;
      if (e.kind === "voice_end") {
        const key = `dialogue:${record.sequence}`;
        ordered.set(key,record.sequence);
        entries.push({key,sessionId,kind:"voice-boundary",conversationId:e.conversationId,epoch:e.epoch,label:"Voice ended",durationMs:e.endedAt-e.startedAt});
      } else if (e.kind === "voice") {
        const event = e.event;
        if (event.kind === "output_transcript") {
          if (!event.text) continue;
          const key = `dialogue:${record.sequence}`;
          ordered.set(key,record.sequence);
          entries.push({key,sessionId,kind:"speech",restored,output:{...(liveOutput ?? {}),unsaved:undefined,unsavedGenerated:undefined,unsavedFragments:undefined,conversationId:e.conversationId,epoch:e.epoch,providerId:e.providerId,orderUnknown:false,outputId:event.outputId,generated:event.text,playback:liveOutput?.playback ?? "unknown",sessionId}});
        } else if (fragment) {
          const key = recognitionIdentity(fragment);
          ordered.set(key,record.sequence);
          if (event.text) entries.push({kind:"recognition",key,sessionId,fragments:[fragment]});
          else emptyArchive.push({fragment,sequence:record.sequence});
        }
      } else if (e.kind === "backend") {
        const ranges = backendRanges.get(e.turnId) ?? []; ranges.push({sequence:record.sequence,...e}); backendRanges.set(e.turnId,ranges);
      } else if (e.kind === "request") {
        const matching = entries.filter(en => en.kind === "message" && (en.message.turnId === e.turnId || en.message.streamTurnId === e.turnId || e.requestId && en.message.requestId === e.requestId));
        const hasRanges = archive.some(item=>item.record.evidence.kind === "backend" && item.record.evidence.turnId===e.turnId);
        if (hasRanges) for (const entry of matching) {
          if (entry.kind === "message" && entry.section !== "answer") ordered.set(entry.key,record.sequence);
        }
        else if (matching.some(en=>en.kind === "message" && en.message.role === "assistant" && !en.message.isStreaming) && !entries.some(en=>en.key===`dialogue-gap:${sessionId}`)) entries.push({key:`dialogue-gap:${sessionId}`,sessionId,kind:"history-notice",label:"Original discussion position unknown."});
      }
    }
    // A range is only a position witness for exact backend-owned text. Never
    // render its copy as an independent answer or rewrite a native transcript.
    const gapKey = `dialogue-gap:${sessionId}`;
    for (const [turnId,ranges] of backendRanges) {
      const messageEntry = entries.find((en): en is MessageEntry => en.kind === "message" && en.message.role === "assistant" && (en.message.turnId === turnId || en.message.streamTurnId === turnId));
      if (!messageEntry) {
        if (buffers.some(buffer=>buffer?.isStreaming)) continue;
        if (!entries.some(e=>e.key===gapKey)) entries.push({key:gapKey,sessionId,kind:"history-notice",label:"Original discussion position unknown."});
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
        const requestIds = new Set(archive.flatMap(item=>item.record.evidence.kind === "request" && item.record.evidence.turnId===turnId ? [item.record.evidence.requestId] : []));
        for (const entry of entries) if (entry.kind === "message" && (entry.message.turnId===turnId || entry.message.streamTurnId===turnId || entry.message.requestId && requestIds.has(entry.message.requestId))) ordered.delete(entry.key);
        if (!entries.some(en=>en.key===gapKey)) entries.push({key:gapKey,sessionId,kind:"history-notice",label:"Original discussion position unknown."}); continue;
      }
      for (let i=entries.length-1;i>=0;i--) if (entries[i]!.kind === "message" && (entries[i] as MessageEntry).message === messageEntry.message && (entries[i] as MessageEntry).section !== "progress") entries.splice(i,1);
      if (!entries.some(en=>en.kind === "message" && en.message === messageEntry.message)) entries.push({...messageEntry,section:"progress"});
      for (const r of ranges) {
        const arrivalKey = `dialogue:${r.sequence}`; ordered.set(arrivalKey,r.sequence);
        entries.push({...messageEntry,key:arrivalKey,section:"answer",start:r.start,end:r.end});
      }
    }
    for (const output of inputs.outputs) {
      if (archivedOutput.has(outputIdentity(output.conversationId,output.epoch,output.outputId)) && !output.unsavedGenerated) continue;
      const generated=output.unsavedGenerated ?? output.generated;
      if (!generated) continue;
      // A tail is identified by its actual source offset, never qualifier state.
      const key = JSON.stringify(["speech", output.conversationId, output.epoch, output.outputId, output.unsavedGenerated ? output.generated.length : 0]);
      ownRuns.add(key);
      for (const run of segments(key, generated, sessionId,undefined,observedThrough)) {
        entries.push({ key: run.key, sessionId, kind: "speech", restored: !output.unsavedGenerated && isRestoredConversationOutput(output), output: { ...output, generated: generated.slice(run.start, run.end), ...(output.unsavedGenerated ? {playback:"unknown" as const,unsaved:true as const,orderUnknown:false} : {}) } });
      }
    }
    // Preserve actual fragment identities before projection. Provider intervals
    // and equal text never determine order or captured-input ownership.
    const empty: ConversationRecognition[] = [];
    for (const fragment of inputs.recognition) {
      const key = recognitionIdentity(fragment);
      if (archivedRecognition.has(key)) continue;
      position(key,undefined,observedThrough);
      if (!fragment.text && !fragment.moved) { empty.push(fragment); continue; }
      entries.push({ kind: "recognition", key, sessionId, fragments: [fragment] });
    }
    entries.push(...inputs.boundaries, ...inputs.coverages);
    const rank = (key:string):readonly number[] => {
      const durable=ordered.get(key); if(durable!==undefined)return [durable,0,0];
      const at=position(key), anchor=positions.get(key)?.afterHostSequence;
      return anchor === undefined ? [-1,0,at] : [anchor,1,at];
    };
    const compareRanks=(x:readonly number[],y:readonly number[]) => x[0]!-y[0]! || x[1]!-y[1]! || x[2]!-y[2]!;
    const compareKeys=(a:string,b:string) => compareRanks(rank(a),rank(b));
    // Each entry's rank once, in source order: a key first ranked here (a
    // history notice) takes its arrival now, even when it is alone.
    const ranked = entries.map(entry => ({ entry, rank: rank(entry.key) }));
    ranked.sort((a, b) => compareRanks(a.rank,b.rank));
    for (const [index, {entry}] of ranked.entries()) entries[index] = entry;
    const stream = (f: ConversationRecognition) => JSON.stringify([f.conversationId, f.epoch, f.kind, f.kind === "input_fragment" ? f.utteranceId : null, !!f.unsaved]);
    const grouped: TranscriptEntry[] = [];
    const members = new Map<TranscriptEntry, Set<string>>();
    for (const entry of entries) {
      const tail = grouped.at(-1);
      if (entry.kind === "recognition" && tail?.kind === "recognition" && stream(entry.fragments[0]!) === stream(tail.fragments[0]!)) { tail.fragments.push(...entry.fragments); members.get(tail)!.add(entry.key); }
      else if (entry.kind === "speech" && tail?.kind === "speech" && entry.output.conversationId === tail.output.conversationId && entry.output.epoch === tail.output.epoch && entry.output.outputId === tail.output.outputId && entry.restored === tail.restored && entry.output.unsaved === tail.output.unsaved) { tail.output = {...tail.output,generated:tail.output.generated+entry.output.generated}; members.get(tail)!.add(entry.key); }
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
    // One tag per interrupted reply, on its last drawn segment.
    const tagged = new Set<string>();
    for (let i = grouped.length - 1; i >= 0; i--) {
      const entry = grouped[i]!;
      if (entry.kind !== "speech") continue;
      const id = outputIdentity(entry.output.conversationId,entry.output.epoch,entry.output.outputId);
      if (interrupted.has(id) && !tagged.has(id)) { tagged.add(id); entry.cutOff = true; }
    }
    // A page can prepend members of a contiguous blurb. Keep an existing
    // canonical member as its DOM key while that exact source still survives.
    // Membership comes only from this projection; it creates no extra order.
    // Every source key stays live, the member whose key gives way to a canonical one too:
    // dropping its arrival would re-rank it as new the next time the session is projected.
    const keys = new Set(entries.map(e => e.key));
    for (const fragment of empty) keys.add(recognitionIdentity(fragment));
    const previous = new Map(previousEntries.map((entry,index)=>[entry.key,{entry,index}]));
    for (const entry of grouped) {
      let surviving: {entry:TranscriptEntry;index:number}|undefined;
      for (const key of members.get(entry)!) {
        const old=previous.get(key);
        if (old && old.entry.kind===entry.kind && old.entry.sessionId===entry.sessionId && (!surviving || old.index<surviving.index)) surviving=old;
      }
      if (surviving) entry.key=surviving.entry.key;
    }
    const last = entries.at(-1);
    if (last) latest.set(sessionId, last.key); else latest.delete(sessionId);
    return { entries: grouped, keys, runs: ownRuns, messages: ownMessages };
  };

  let sessions = new Map<SessionKey, Projection>();
  let parts = new Map<SessionKey, VoiceInputs>();
  let voiceRead: unknown[] = [];
  let voiceStale = true;
  /** Sessions whose arrival state changed outside a projection (a local voice boundary). */
  const dirty = new Set<SessionKey>();
  const hold = (p: Projection) => { livePositions.hold(p.keys); liveRuns.hold(p.runs); liveMessages.hold(p.messages); };
  const release = (p: Projection) => { livePositions.release(p.keys); liveRuns.release(p.runs); liveMessages.release(p.messages); };
  const sync = () => {
    const s = chat.getState();
    const v = voice.getState();
    const read = [v.profile, v.recognition, v.outputs, v.active, v.sessionId, v.dialogue, v.dialogueRestoredThrough];
    if (voiceStale || !sameItems(read, voiceRead)) { parts = partition(v); voiceRead = read; voiceStale = false; }
    const sources = new Map<SessionKey, SessionBuffer[]>();
    const source = (sessionId: SessionKey, buffer: SessionBuffer) => { const own = sources.get(sessionId); if (own) own.push(buffer); else sources.set(sessionId, [buffer]); };
    for (const [sessionId, buffer] of Object.entries(s.buffers)) source(sessionId, buffer);
    for (const [sessionId, buffer] of Object.entries(s.detachedDrafts)) source(sessionId, buffer);
    source(null, s.draft);
    for (const sessionId of parts.keys()) if (!sources.has(sessionId)) sources.set(sessionId, []);
    const next = new Map<SessionKey, Projection>();
    let replaying = false;
    for (const [sessionId, buffers] of sources) {
      if (buffers.some(buffer => buffer?.replay)) replaying = true;
      const inputs = parts.get(sessionId) ?? NO_VOICE;
      const speaking = v.active && v.sessionId === sessionId;
      const owner = speaking && !!v.profile?.historyOwnerId;
      const old = sessions.get(sessionId);
      if (old && !dirty.has(sessionId) && old.speaking === speaking && old.owner === owner
        && (old.voice === inputs || sameItems(old.voice.signature, inputs.signature))
        && old.buffers.length === buffers.length
        && buffers.every((buffer, index) => buffer?.messages === old.buffers[index]?.messages && buffer?.isStreaming === old.buffers[index]?.isStreaming)) {
        old.voice = inputs; old.buffers = buffers;
        next.set(sessionId, old);
        continue;
      }
      const projection: Projection = { buffers, speaking, owner, voice: inputs, ...project(sessionId, buffers, inputs, v, old?.entries ?? NO_ENTRIES) };
      hold(projection);
      if (old) release(old);
      next.set(sessionId, projection);
    }
    for (const [sessionId, old] of sessions) if (!next.has(sessionId)) { release(old); latest.delete(sessionId); }
    sessions = next;
    dirty.clear();
    // Preserve positions across partial history chunks, but do not retain the
    // identities of evicted sessions/outputs for the lifetime of a mounted app.
    if (!replaying) { livePositions.sweep(); liveRuns.sweep(); liveMessages.sweep(); }
    const published = state.getState().sessions;
    const bySession = new Map<SessionKey, TranscriptEntry[]>();
    for (const [sessionId, projection] of sessions) if (projection.entries.length) bySession.set(sessionId, projection.entries);
    if (bySession.size === published.size && sameItems([...bySession.keys()], [...published.keys()]) && [...bySession].every(([sessionId, entries]) => published.get(sessionId) === entries)) return;
    state.setState({ entries: [...bySession.values()].flat(), sessions: bySession });
  };
  // Changes in selection, timers and microphone state need no transcript scan.
  const stopChat = chat.subscribe((next, old) => {
    if (next.buffers !== old.buffers || next.draft !== old.draft || next.detachedDrafts !== old.detachedDrafts) sync();
  });
  const stopVoice = voice.subscribe((next, old) => {
    // A local end is not drawn: the host's retained end (#3729) is the divider.
    if (old.profile && old.active && next.active && next.profile && next.profile.conversationId === old.profile.conversationId && next.profile.epoch > old.profile.epoch) {
      const profile = next.profile;
      const key = JSON.stringify(["voice-boundary", profile.conversationId, profile.epoch, sequence]);
      position(key); latest.set(next.sessionId, key); dirty.add(next.sessionId); voiceStale = true;
      boundaries.set(key, { kind: "voice-boundary", key, sessionId: next.sessionId, conversationId: profile.conversationId, epoch: profile.epoch, label: "Voice reconnected" });
    }
    // The coverage notice opens the live section once its conversation reports it.
    const coverage = next.active ? next.profile?.historyCoverage : undefined;
    if (next.profile && coverage && ((coverage.includedMessages ?? 0) > 0 || coverage.state !== "complete") && !coverages.has(JSON.stringify(["voice-coverage", next.profile.conversationId]))) {
      const key = JSON.stringify(["voice-coverage", next.profile.conversationId]);
      position(key); latest.set(next.sessionId, key); dirty.add(next.sessionId); voiceStale = true;
      coverages.set(key, { kind: "voice-coverage", key, sessionId: next.sessionId, conversationId: next.profile.conversationId, coverage });
    }
    if (next.profile !== old.profile || next.recognition !== old.recognition || next.outputs !== old.outputs || next.active !== old.active || next.sessionId !== old.sessionId || next.dialogue !== old.dialogue) sync(); });
  sync();
  return { state, dispose() {
    stopChat(); stopVoice(); positions.clear(); boundaries.clear(); coverages.clear(); runs.clear(); split.clear(); latest.clear(); textBefore.clear();
    messageKeys.clear(); livePositions.clear(); liveRuns.clear(); liveMessages.clear(); sessions = new Map(); parts = new Map();
    state.setState({ entries: [], sessions: new Map() });
  } };
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
