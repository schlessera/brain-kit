/** Authorized, bounded startup snapshot. Native answers remain the text authority. */
import type { DialoguePage, DialogueRecord, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { ConversationHistoryEnvelope, HistoricalItem, HistoryGapReason } from "@schlessera/brain-ui-sdk/server";
import type { WsHost } from "./host.js";
import type { DialogueTarget } from "./dialogue-storage.js";

/** No request replay, provider call or mutation of the native transcript. */
export async function readLiveHistory(host: WsHost, principalId: string, target: DialogueTarget,
  authorized: () => boolean): Promise<ConversationHistoryEnvelope | undefined> {
  if (!authorized()) return;
  // Drain observations already accepted before sampling the journal high-water.
  await host.historySettled();
  if (!authorized()) return;
  const page = await host.catalog.dialogueRead?.(principalId, target);
  if (!authorized()) return;
  let messages: SessionHistoryMessage[] = [];
  if (target.sessionId) {
    const backend = await host.registry.getBackendForSession(host.catalog.getStoredBackendId(target.sessionId));
    if (!authorized()) return;
    const native = await backend.getHistory(target.sessionId);
    if (!authorized()) return;
    await host.historySettled();
    if (!authorized()) return;
    // Fail closed on provenance read errors: a task wrapper must never default to typed.
    messages = host.prepareHistory(target.sessionId, native, true);
  }
  const conversations = [...new Set(page?.records.flatMap(r => r.evidence.kind === "voice" ? [r.evidence.conversationId] : []) ?? [])].slice(-128);
  const canonicalVoiceTurns = new Set<string>();
  const facts: Array<{ item: HistoricalItem; turnId: string; requestId: string }> = [];
  for (const id of conversations) {
    const stored = await host.catalog.loadConversation?.(id, principalId);
    if (!authorized()) return;
    if (!stored || stored.id !== id || stored.principalId !== principalId || stored.sessionId !== target.sessionId) continue;
    for (const receipt of stored.receipts) {
      // Retained receipts can expose contradictory positive provenance, never
      // authenticate a missing source row or resurrect an evicted carrier.
      if(receipt.provenance==="contextual" && receipt.turnId && messages.some(m=>m.role==="user" &&
        m.turnId===receipt.turnId && m.content===receipt.submitted && m.source && m.source!=="voice-context"))
        throw Error("Historical request provenance is inconsistent");

      if (receipt.turnId && receipt.provenance !== "contextual" && page?.records.some(r => {
        const e = r.evidence;
        return e.kind === "voice" && e.conversationId === id && e.epoch === receipt.epoch && e.event.kind === "input_fragment" && e.event.utteranceId === receipt.utteranceId;
      })) canonicalVoiceTurns.add(receipt.turnId);
      if (receipt.state !== "completed" || !receipt.turnId) continue;
      const result = stored.results.find(r => r.requestId === receipt.requestId);
      const answer = messages.find(m => m.role === "assistant" && m.turnId === receipt.turnId);
      const witnessed = answer && page && nativeRanges(page.records, receipt.turnId, answer.content);
      // Completion after the sampled high-water cannot acquire its earlier
      // request's position. Unwitnessed full native text remains separate data.
      if (!witnessed || !result?.facts || !page?.records.some(r => r.evidence.kind === "request" && r.evidence.turnId === receipt.turnId && r.evidence.requestId === receipt.requestId)) continue;
      facts.push({ turnId: receipt.turnId, requestId: receipt.requestId, item: {
        ref: JSON.stringify(["fact", id, receipt.epoch, receipt.requestId, receipt.turnId]), kind: "host_fact", outcome: "completed", text: result.facts,
        result: { conversationId: id, epoch: receipt.epoch, requestId: receipt.requestId, turnId: receipt.turnId }, completeness: "retained_bounded",
      } });
    }
  }
  if (!authorized()) return;
  // A replaced/adopted generation cannot be treated as the sampled owner.
  if (page) {
    const current = host.catalog.dialogueOwnerForId?.(page.ownerId, principalId);
    if (host.catalog.dialogueOwnerForId && (!current || current.id !== page.ownerId || current.generation !== page.generation)) throw Error("Historical source changed");
  }
  return freezeHistory(projectLiveHistory(messages, page ?? undefined, facts, canonicalVoiceTurns, new Set(messages.flatMap((m,i)=>m.role==="user"&&!m.source?[i]:[]))));
}

/** Exact joins supply interleaving; unavailable positions are explicitly qualified. */
export function projectLiveHistory(messages: readonly SessionHistoryMessage[], page?: DialoguePage,
  facts: readonly { item: HistoricalItem; turnId: string; requestId: string }[] = [], canonicalVoiceTurns: ReadonlySet<string> = new Set(), unprovenUsers: ReadonlySet<number> = new Set()): ConversationHistoryEnvelope {
  const reasons = new Set<HistoryGapReason>();
  if (page?.cursor || messages.length > 128) reasons.add("older_omitted");
  if (page?.coverage === "legacy") reasons.add("pre_upgrade");
  if (page?.coverage === "partial") reasons.add("write_gap");
  const records = page?.records ?? [];
  const ordered: Array<{ order: number; index: number; item: HistoricalItem }> = [];
  let index = 0;
  const add = (order: number, item: HistoricalItem) => ordered.push({ order, index: index++, item });
  // Native groups retain their own order even when cross-stream position is
  // unknown. Known request/range anchors position complete exchanges;
  // an unwitnessed prefix precedes the earliest journal observation. Later
  // unknown groups follow their native predecessor, before the next witness.
  // These are selection slots, not proof of cross-stream chronology: gaps and
  // partial coverage preserve that uncertainty, including failed source writes.
  const recent = messages.slice(-128);
  type Positioned = { order: number; item: HistoricalItem };
  const groups: Array<{ items: HistoricalItem[]; positioned: Positioned[]; lastFactAfter?: number }> = [];
  let group: typeof groups[number] | undefined;
  for (let i = 0; i < recent.length; i++) {
    const message = recent[i]!;
    if (!group || message.role === "user") {
      group = { items: [], positioned: [] }; groups.push(group);
    }
    if (!message.content || message.role === "user" && message.source === "voice-context") continue;
    const ref = JSON.stringify(["native", messages.length - recent.length + i, message.role]);
    if (message.role === "user") {
      if(unprovenUsers.has(messages.length-recent.length+i)) {
        reasons.add("source_unavailable");
        group.items.push({ref,kind:"gap",reason:"source_unavailable"});continue;
      }
      const nextUser = recent.findIndex((m,j) => j > i && m.role === "user");
      const answer = recent.slice(i + 1, nextUser < 0 ? undefined : nextUser).find(m => m.role === "assistant");
      if (message.source === "voice-conversation" && answer?.turnId && canonicalVoiceTurns.has(answer.turnId)) continue;
      const request = records.find(r => r.evidence.kind === "request" && r.evidence.turnId === (message.turnId ?? answer?.turnId));
      const item: HistoricalItem = { ref, kind: "typed", role: "user", text: message.content,
        ...(message.source === "voice-conversation" || message.source === "voice-dictate" ? { source: message.source } : {}) };
      group.items.push(item);
      if (request) group.positioned.push({order:request.sequence-0.5,item});
    } else {
      const fact = facts.find(f=>f.turnId === message.turnId);
      const ranges = message.turnId ? nativeRanges(records, message.turnId, message.content) : undefined;
      if (fact) {
        // Facts join later at their witnessed completion; retain this native
        // anchor so surrounding unknown groups cannot jump before the result.
        if (ranges) {
          group.positioned.push({order:ranges.at(-1)!.sequence+0.25,item:fact.item});
          group.lastFactAfter = group.items.length;
        }
        continue;
      }
      if (ranges) for (const r of ranges) {
        const item: HistoricalItem = {ref:`${ref}:${r.start}`,kind:"typed",role:"assistant",text:message.content.slice(r.start,r.end)};
        group.items.push(item); group.positioned.push({order:r.sequence,item});
      } else {group.items.push({ref,kind:"typed",role:"assistant",text:message.content});}
    }
  }
  const journalStart = records.length ? Math.min(...records.map(r=>r.sequence)) : 0;
  let previous = journalStart - 1;
  let anchored = false;
  for (let i=0;i<groups.length;i++) {
    const g=groups[i]!;
    const positions = new Map(g.positioned.map(p=>[p.item.ref,p.order]));
    for (let j=0;j<g.items.length;) {
      const item=g.items[j]!, at=positions.get(item.ref);
      if (at !== undefined && at >= previous) {
        add(at,item); previous=at; anchored=true; j++; continue;
      }
      // Keep every exact range at its witnessed position even if its request
      // has no witness. Only the unpositioned native run receives a default slot.
      const startIndex=j;
      while(j<g.items.length && !(positions.has(g.items[j]!.ref) && positions.get(g.items[j]!.ref)!>=previous)) j++;
      const run=g.items.slice(startIndex,j);
      if(records.length) reasons.add("ambiguous_order");
      const nextOwn=j<g.items.length ? positions.get(g.items[j]!.ref) : undefined;
      const nextOther=groups.slice(i+1).flatMap(n=>n.positioned).find(p=>p.order>previous)?.order;
      const next=nextOwn ?? nextOther;
      const laterJournal=records.find(r=>r.sequence>previous)?.sequence;
      const end=!anchored ? Math.min(journalStart,next ?? journalStart)
        : Math.min(next ?? Infinity,laterJournal ?? Infinity,previous+1);
      const start=previous,step=(end-start)/(run.length+2);
      if(records.length) add(start+step/2,{ref:`native-gap:${i}:${startIndex}`,kind:"gap",reason:"ambiguous_order"});
      run.forEach((entry,k)=>add(start+step*(k+1),entry));
      previous=start+step*run.length;
    }
    // A deduped fact is emitted later at its exact completion, but still anchors
    // the next native group here. It never acquires a second provider item.
    for(const p of g.positioned) if(p.item.kind==="host_fact" && p.order>=previous){previous=p.order;anchored=true;}
  }
  for (const record of records) {
    const e = record.evidence;
    if (e.kind !== "voice" || !e.event.text) continue;
    const ref = JSON.stringify([page!.ownerId, page!.generation, record.identity]);
    const provenance = { providerId: e.providerId, conversationId: e.conversationId, epoch: e.epoch };
    if (e.event.kind === "output_transcript") add(record.sequence, { ref, kind: "generated", text: e.event.text, provenance });
    else add(record.sequence, { ref, kind: "recognized", text: e.event.text, finalization: e.event.finalization ?? "unknown", provenance });
  }
  for (const fact of facts) {
    const ranges = records.filter(r => r.evidence.kind === "backend" && r.evidence.turnId === fact.turnId);
    const request = records.find(r => r.evidence.kind === "request" && r.evidence.turnId === fact.turnId && r.evidence.requestId === fact.requestId);
    if (request) add((ranges.at(-1)?.sequence ?? request.sequence) + 0.25, fact.item);
  }
  if (!page && records.length === 0 && recent.some(m => m.source === "voice-context")) reasons.add("source_unavailable");
  const state = reasons.has("write_gap") || reasons.has("pre_upgrade") || reasons.has("ambiguous_order") || reasons.has("source_unavailable") ? "partial" : reasons.size ? "bounded" : "complete";
  const items = ordered.sort((a,b) => a.order-b.order || a.index-b.index).map(v => v.item);
  // Native order proves its tail follows every earlier exact native anchor.
  // An older voice tail cannot be the newest once a later native anchor exists;
  // an entirely unwitnessed prefix still has unknown recency, not a fake date.
  const lastNativeGroup = groups.findLast(g=>g.items.length || g.positioned.length);
  const lastFact = lastNativeGroup?.positioned.at(-1)?.item;
  // A fact replaces only its own native item, never a later adjacent answer.
  const nativeTail = lastFact?.kind==="host_fact" && lastNativeGroup?.lastFactAfter===lastNativeGroup?.items.length
    ? lastFact : lastNativeGroup?.items.at(-1);
  const nativeUpperBound = nativeTail && lastNativeGroup?.positioned.find(p=>p.item.ref===nativeTail.ref)?.order;
  const nativeLowerBound = Math.max(-Infinity,...groups.flatMap(g=>g.positioned.map(p=>p.order)));
  const voiceTail = ordered.findLast(v=>v.item.kind==="recognized" || v.item.kind==="generated");
  const newestRefs = [nativeTail && (nativeUpperBound===undefined || !voiceTail || nativeUpperBound>voiceTail.order) ? nativeTail.ref : undefined,
    voiceTail && voiceTail.order > nativeLowerBound ? voiceTail.item.ref : undefined].filter((r):r is string=>r!==undefined);
  return { version: 1, coverage: { state, reasons: [...reasons].sort() }, items, ...(newestRefs.length ? {newestRefs} : {}) };
}

/** Recursively freeze this host-owned snapshot before handing it to a provider. */
function freezeHistory<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeHistory(child);
    Object.freeze(value);
  }
  return value;
}

/** Range copies prove position only for this exact complete native answer. */
function nativeRanges(records: readonly DialogueRecord[], turnId: string, text: string) {
  const ranges = records.flatMap(r => r.evidence.kind === "backend" && r.evidence.turnId === turnId ? [{ ...r.evidence, sequence: r.sequence }] : []).sort((a,b) => a.start-b.start);
  const exact = ranges.length > 0 && ranges[0]!.start === 0 && ranges.at(-1)!.end === text.length
    && ranges.every((r,j) => (!j || ranges[j-1]!.end === r.start) && text.slice(r.start,r.end) === r.text && Bun.SHA256.hash(r.text,"hex") === r.digest);
  return exact ? ranges : undefined;
}
