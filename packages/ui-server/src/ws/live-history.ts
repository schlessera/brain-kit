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
    const sourced = host.catalog.attachMessageSources?.(target.sessionId, native, true) ?? native;
    messages = host.prepareHistory(target.sessionId, sourced);
  }
  const conversations = [...new Set(page?.records.flatMap(r => r.evidence.kind === "voice" ? [r.evidence.conversationId] : []) ?? [])].slice(-128);
  const canonicalVoiceTurns = new Set<string>();
  const facts: Array<{ item: HistoricalItem; turnId: string; requestId: string }> = [];
  for (const id of conversations) {
    const stored = await host.catalog.loadConversation?.(id, principalId);
    if (!authorized()) return;
    if (!stored || stored.sessionId !== target.sessionId) continue;
    for (const receipt of stored.receipts) {
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
  return freezeHistory(projectLiveHistory(messages, page ?? undefined, facts, canonicalVoiceTurns));
}

/** Exact joins supply interleaving; unavailable positions are explicitly qualified. */
export function projectLiveHistory(messages: readonly SessionHistoryMessage[], page?: DialoguePage,
  facts: readonly { item: HistoricalItem; turnId: string; requestId: string }[] = [], canonicalVoiceTurns: ReadonlySet<string> = new Set()): ConversationHistoryEnvelope {
  const reasons = new Set<HistoryGapReason>();
  if (page?.cursor || messages.length > 128) reasons.add("older_omitted");
  if (page?.coverage === "legacy") reasons.add("pre_upgrade");
  if (page?.coverage === "partial") reasons.add("write_gap");
  const records = page?.records ?? [];
  const ordered: Array<{ order: number; index: number; item: HistoricalItem }> = [];
  let index = 0;
  const add = (order: number, item: HistoricalItem) => ordered.push({ order, index: index++, item });
  // Native order is known, but absent range witnesses cannot invent cross-stream order.
  const recent = messages.slice(-128);
  let preceding = -recent.length;
  for (let i = 0; i < recent.length; i++) {
    const message = recent[i]!;
    if (message.role === "assistant" && facts.some(f => f.turnId === message.turnId)) continue;
    if (!message.content || message.role === "user" && message.source === "voice-context") continue;
    const ref = JSON.stringify(["native", messages.length - recent.length + i, message.role]);
    if (message.role === "user") {
      const answer = recent.slice(i + 1).find(m => m.role === "assistant");
      if (message.source === "voice-conversation" && answer?.turnId && canonicalVoiceTurns.has(answer.turnId)) continue;
      const request = records.find(r => r.evidence.kind === "request" && r.evidence.turnId === answer?.turnId);
      add(request ? request.sequence - 0.5 : preceding++, { ref, kind: "typed", role: "user", text: message.content,
        ...(message.source === "voice-conversation" || message.source === "voice-dictate" ? { source: message.source } : {}) });
    } else {
      const ranges = message.turnId ? nativeRanges(records, message.turnId, message.content) : undefined;
      // A completed host fact is a separate exact retained-result source. The
      // full native answer is retained as backend text, never a generated reply.
      if (ranges) for (const r of ranges) add(r.sequence, { ref: `${ref}:${r.start}`, kind: "typed", role: "assistant", text: message.content.slice(r.start,r.end) });
      else {
        if (records.length) reasons.add("ambiguous_order");
        add(preceding++, { ref, kind: "typed", role: "assistant", text: message.content });
      }
    }
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
  const state = reasons.has("write_gap") || reasons.has("pre_upgrade") || reasons.has("ambiguous_order") ? "partial" : reasons.has("source_unavailable") ? "unavailable" : reasons.size ? "bounded" : "complete";
  return { version: 1, coverage: { state, reasons: [...reasons].sort() }, items: ordered.sort((a,b) => a.order-b.order || a.index-b.index).map(v => v.item) };
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
