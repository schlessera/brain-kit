/**
 * Transcript replay (#1361): history replacing or extending a buffer, and
 * the reconciliation that keeps what the reader already saw — exchange
 * turns, streamed text, tools and attachment previews.
 */
import type { AskUserExchange, ChatMessage, ChatState, MessagePart, SessionChat, ToolCall } from "../chat-state.js";
import type { ChatSliceContext } from "./buffers.js";
import { appendPart, emptyChat, evictStale, revokeAttachmentUrls } from "./buffers.js";


/**
 * History rebuilds an exchange from its tool call, which names no turn. When
 * the buffer it replaces had already learned the turn from the live request,
 * keep it: the answer must be sent with that binding.
 */
function withKnownTurns(next: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  const turns = new Map<string, string>();
  for (const m of previous) for (const e of m.askUserExchanges ?? []) if (e.turnId) turns.set(e.requestId, e.turnId);
  if (turns.size === 0) return next;
  return next.map((m) =>
    m.askUserExchanges?.some((e) => !e.turnId && turns.has(e.requestId))
      ? {
          ...m,
          askUserExchanges: m.askUserExchanges.map((e) =>
            !e.turnId && turns.has(e.requestId) ? { ...e, turnId: turns.get(e.requestId)! } : e
          ),
        }
      : m
  );
}

/**
 * A history replay of a transcript already on screen (a reconnect's resume or
 * snapshot, #1013) keeps what it repeats: a message at the same place with the
 * same role and text keeps its id and time, so React keeps its node and the
 * reader's place. The streaming answer counts as repeated when one text
 * continues the other, and it stays streaming: the host's status after the
 * history says whether the turn is still running, and only that ends it.
 */
function drawnText(message: ChatMessage): string {
  return message.parts.filter((part) => part.kind === "text").map((part) => part.text).join("") || message.content;
}

/** Lost deltas leave holes; subsequent deltas retain their order. */
function includesDrawnText(text: string, drawn: string): boolean {
  let at = 0;
  for (let i = 0; i < text.length && at < drawn.length; i++) if (text[i] === drawn[at]) at++;
  return at === drawn.length;
}

/** Shared tools keep their chronological IDs even when either copy missed a call. */
function compatibleToolOrder(a: ToolCall[], b: ToolCall[]): boolean {
  const aIds = new Set(a.map((t) => t.id)), bIds = new Set(b.map((t) => t.id));
  const sharedA = a.filter((t) => bIds.has(t.id)), sharedB = b.filter((t) => aIds.has(t.id));
  return sharedA.every((t, i) => t.id === sharedB[i]?.id)
    && (sharedA.length > 0 || !a.length || !b.length);
}

/** The host's display-size bound must not shorten text the page already drew. */
function keepUnclippedText(next: string | undefined, old: string | undefined): string | undefined {
  const elision = next?.match(/\n…\[\d+ chars elided\]$/);
  return elision && old?.startsWith(next!.slice(0, elision.index)) ? old : next;
}

/** Clipped blocks may split a live text part differently from stored entries. */
function restoreClippedParts(parts: MessagePart[], old: ChatMessage): MessagePart[] {
  const offsets = { text: 0, thinking: 0 };
  return parts.map((part, index) => {
    if (part.kind === "tool") return part;
    const prior = old.parts.filter((p) => p.kind === part.kind).map((p) => (p as { text: string }).text);
    const all = prior.join("") || (part.kind === "text" ? old.content : old.thinking ?? "");
    const at = offsets[part.kind];
    const elision = part.text.match(/\n…\[(\d+) chars elided\]$/);
    let text = part.text;
    if (elision && all.startsWith(text.slice(0, elision.index), at)) {
      // Restore through the drawn block containing this prefix, rather than
      // swallowing later blocks around a tool or thinking section.
      let end = 0;
      for (const block of prior) {
        end += block.length;
        if (end >= at + elision.index! && end > at) break;
      }
      // Stored blocks can share one live block across missed intervening
      // parts. Nonfinal prefixes stop at their stored text boundary.
      if (parts.slice(index + 1).some((p) => p.kind === part.kind)) end = Math.min(end, at + elision.index! + Number(elision[1]));
      text = all.slice(at, prior.length ? end : all.length);
    }
    offsets[part.kind] = all.startsWith(text, at) ? at + text.length : at;
    return text === part.text ? part : { ...part, text };
  });
}

/** A message's text parts, in order. */
export function textsOf(m: ChatMessage): string[] {
  return m.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
}

function keepDrawnMessages(next: ChatMessage[], previous: Pick<SessionChat, "messages" | "isStreaming">, partial = true): Pick<SessionChat, "messages" | "isStreaming"> {
  // Only the transcript's tail can still be streaming: a message after it
  // (a follow-up that started) means its turn is over.
  const tail = next.length - 1;
  let streaming = false;
  const messages = next.map((received, i) => {
    const old = previous.messages[i];
    if (!old || old.role !== received.role) return received;
    const toolsElided = received.content.match(/\n…\[(\d+) tool calls elided\]$/);
    const boundedTools = toolsElided && compatibleToolOrder(received.toolCalls, old.toolCalls);
    const content = boundedTools ? received.content.slice(0, toolsElided.index) : received.content;
    const unclippedContent = keepUnclippedText(content, old.content)!;
    const m: ChatMessage = {
      ...received,
      content: unclippedContent,
      thinking: keepUnclippedText(received.thinking, old.thinking),
      parts: restoreClippedParts(received.parts.filter((part) => !boundedTools || part.kind !== "text" || part.text !== toolsElided![0]), old),
      toolCalls: [...received.toolCalls, ...(boundedTools ? old.toolCalls.filter((t) => !received.toolCalls.some((n) => n.id === t.id)) : [])].map((tool) => ({
        ...tool, output: keepUnclippedText(tool.output, old.toolCalls.find((t) => t.id === tool.id)?.output),
      })),
    };
    if (/\n…\[\d+ chars elided\]/.test(content)) m.content = drawnText(m);
    if (content !== unclippedContent && unclippedContent === old.content && drawnText(old).startsWith(drawnText(m))) m.content = old.content;
    // The array bound can omit a new trailing block while the aggregate
    // still carries it. Keep drawn cards, then add the newly proven suffix.
    if (m.content.startsWith(old.content) && m.content.length >= old.content.length
      && (boundedTools || m.content.length > old.content.length || drawnText(m).length < drawnText(old).length)
      && drawnText(m).length <= drawnText(old).length
      && (!old.turnId || !m.turnId || old.turnId === m.turnId)
      && compatibleToolOrder(old.toolCalls, m.toolCalls)) {
      const retained = mergeLive(old, m);
      const suffix = m.content.slice(old.content.length);
      m.parts = suffix ? appendPart(retained.parts, "text", suffix) : retained.parts;
      m.toolCalls = retained.toolCalls;
    }
    const live = previous.isStreaming && old.isStreaming === true && m.role === "assistant";
    // Claude history adds separators to its aggregate across assistant
    // entries; the chronological text parts are the actual drawn text.
    const mine = drawnText(old), theirs = drawnText(m);
    const provenTurn = m.turnId && m.turnId === (old.turnId ?? old.streamTurnId);
    const clipped = received.parts.some((p) => p.kind === "text" && /\n…\[\d+ chars elided\]$/.test(p.text));
    const opening = received.parts.find((p) => p.kind === "text");
    // A bound cannot disprove this drawn continuation: retain even a short
    // shared opening until the scoped status settles its turn. Tool/request
    // identities and a different proven turn still reject a replacement.
    const boundedContinuation = !!boundedTools || (clipped && opening?.kind === "text" && mine.length > 0
      && opening.text.length > 0 && opening.text[0] === mine[0]);
    const continuing = live || !!(old.turnId ?? old.streamTurnId);
    const same = mine === theirs || boundedContinuation || (continuing && (provenTurn || theirs.startsWith(mine) || mine.startsWith(theirs)
      || (mine.length > 0 && theirs.length > 0 && (includesDrawnText(theirs, mine) || includesDrawnText(mine, theirs)))));
    // Text alone does not make it the same message: a tool-only answer has
    // none, and its cards keep state. A known turn or request must agree.
    const shared = Math.min(old.toolCalls.length, m.toolCalls.length);
    const compatibleTools = compatibleToolOrder(old.toolCalls, m.toolCalls);
    const sameTools = continuing || boundedContinuation ? compatibleTools || (live && provenTurn)
      : old.toolCalls.length === m.toolCalls.length && old.toolCalls.slice(0, shared).every((t, k) => t.id === m.toolCalls[k]!.id);
    const knownTurn = old.turnId ?? old.streamTurnId;
    const sameTurn = !knownTurn || !m.turnId || knownTurn === m.turnId;
    if (!same || !sameTools || !sameTurn) return m;
    if (live && i === tail) {
      streaming = true;
      return mergeLive(old, m);
    }
    if ((continuing && m.role === "assistant" && old.toolCalls.some((t) => !m.toolCalls.some((n) => n.id === t.id)))
      || (boundedContinuation && (boundedTools || m.parts.some((p) => p.kind === "text" && /\n…\[\d+ chars elided\]$/.test(p.text))))) {
      return { ...mergeLive(old, m), isStreaming: false };
    }
    return { ...m, id: old.id, timestamp: old.timestamp, ...(old.attachments ? { attachments: old.attachments } : {}) };
  });
  // Another client can start a turn whose user message this page learns only
  // from history. Its live answer moves across that one inserted user, but
  // only when the whole earlier prefix repeats. Apply the same answer guards
  // at its new position; this never searches older answers for matching text.
  const live = previous.messages.at(-1);
  const liveAt = previous.messages.length - 1;
  // A connect greeting opens an empty placeholder even for a finished turn.
  // Only delivered progress or a known turn identifies an answer to move.
  if (previous.isStreaming && live?.role === "assistant" && live.isStreaming
    && (live.turnId || live.streamTurnId || live.content || live.thinking || live.toolCalls.length || live.askUserExchanges?.length)
    && next[liveAt]?.role === "user"
    && messages.slice(0, liveAt).every((m, i) => m.id === previous.messages[i]!.id)) {
    if (next.length === previous.messages.length + 1 && next.at(-1)?.role === "assistant") {
      const answer = keepDrawnMessages([next.at(-1)!], { messages: [live], isStreaming: true }, false);
      return { messages: [...messages.slice(0, -1), ...answer.messages], isStreaming: answer.isStreaming };
    }
    // A chunk can stop at the inserted user. Keep the answer mounted until
    // its chunk arrives, including any deltas received between the chunks.
    if (partial && next.length === previous.messages.length) {
      return { messages: [...messages, { ...live, turnId: undefined, streamTurnId: live.turnId ?? live.streamTurnId }], isStreaming: true };
    }
  }
  // The first frame can be only a prefix. Keep its matching drawn suffix
  // until the host's post-history status settles the replay: otherwise a
  // painted frame between WS tasks unmounts it and loses the scroll anchor.
  if (partial && next.length < previous.messages.length) {
    const suffix = previous.messages.slice(next.length).map((m) => m.isStreaming
      ? { ...m, turnId: undefined, streamTurnId: m.turnId ?? m.streamTurnId } : m);
    return { messages: [...messages, ...suffix], isStreaming: previous.isStreaming };
  }
  // A backend may keep an answer only once it ends, so a replay mid-turn can
  // stop just before the answer on screen. Everything else repeated: the
  // answer is still being written, and stays (the turn's end replays again).
  if (previous.isStreaming && live?.role === "assistant" && live.isStreaming
    && next.length === previous.messages.length - 1 && messages.every((m, i) => m.id === previous.messages[i]!.id)) {
    return { messages: [...messages, { ...live, turnId: undefined, streamTurnId: live.turnId ?? live.streamTurnId }], isStreaming: true };
  }
  return { messages, isStreaming: streaming };
}

/**
 * The live answer, from the page's copy and the host's: each may hold
 * progress the other lacks (text the page missed while away, a tool or
 * thinking that arrived while the history was read). A lagging copy cannot
 * erase text already drawn, even if it is longer; the other's tools join
 * the retained copy, and its outputs fill that copy's.
 * The turn is the history's alone: only a host-proven turn may let the
 * reader's view clear a tracker (D52 §4). The frames' turn stays for
 * correlation.
 */
function mergeLive(old: ChatMessage, m: ChatMessage): ChatMessage {
  const thinkingSize = (message: ChatMessage) => message.parts.reduce((n, p) => n + (p.kind === "thinking" ? p.text.length : 0), 0);
  const moreThinking = thinkingSize(m) > thinkingSize(old);
  const unresolvedClip = m.parts.some((p) => p.kind === "text" && /\n…\[\d+ chars elided\]$/.test(p.text));
  const base = unresolvedClip || !includesDrawnText(drawnText(m), drawnText(old))
    || (drawnText(old).length === drawnText(m).length && !moreThinking && m.toolCalls.length <= old.toolCalls.length) ? old : m;
  const other = base === old ? m : old;
  const theirs = new Map(other.toolCalls.map((t) => [t.id, t]));
  // A tool the other copy saw finish is that copy's, state and all: an
  // approval the host settled meanwhile is not offered again.
  const toolCalls = base.toolCalls.map((t) => {
    const o = theirs.get(t.id);
    if (!o && t.status === "pending_approval") return { ...t, restored: true as const, approvalTurnId: undefined };
    return o && ((o.output !== undefined && t.output === undefined) || ((t.status === "streaming" || t.status === "pending_approval") && o.status !== t.status)) ? o : t;
  });
  let parts = [...base.parts];
  for (const t of other.toolCalls) {
    if (toolCalls.some((b) => b.id === t.id)) continue;
    {
      const sourceAt = other.parts.findIndex((p) => p.kind === "tool" && other.toolCalls[p.toolIndex]?.id === t.id);
      const following = sourceAt < 0 ? [] : other.parts.slice(sourceAt + 1);
      const preceding = sourceAt < 0 ? [] : other.parts.slice(0, sourceAt).filter((p) => p.kind === "tool").map((p) => other.toolCalls[p.toolIndex]!.id);
      const start = parts.findLastIndex((p) => p.kind === "tool" && preceding.includes(toolCalls[p.toolIndex]!.id)) + 1;
      let at = -1;
      // A text block can be the nearest shared boundary. A missed tool may
      // also have coalesced two drawn text blocks: split at that boundary.
      for (const next of following) {
        for (let index = start; index < parts.length; index++) {
          const part = parts[index]!;
          if (next.kind === "tool") {
            if (part.kind === "tool" && toolCalls[part.toolIndex]!.id === other.toolCalls[next.toolIndex]!.id) at = index;
          } else if (part.kind === next.kind && next.text.trim().length > 0 && part.text.trim().length > 0) {
            const needle = next.text.replace(/\n…\[\d+ chars elided\]$/, "");
            if (!needle.trim()) continue;
            const offset = part.text.indexOf(needle);
            if (offset >= 0 || needle.startsWith(part.text)) {
              at = index;
              if (offset > 0) {
                parts.splice(index, 1, { ...part, text: part.text.slice(0, offset) }, { ...part, text: part.text.slice(offset) });
                at++;
              }
            }
          }
          if (at >= 0) break;
        }
        if (at >= 0) break;
      }
      if (at < 0 && sourceAt >= 0 && other === m && start > 0) at = start;
      parts.splice(at < 0 ? parts.length : at, 0, { kind: "tool", toolIndex: toolCalls.length });
    }
    toolCalls.push(other === old && t.status === "pending_approval"
      ? { ...t, restored: true as const, approvalTurnId: undefined } : t);
  }
  // The union's flat order must agree with its drawn chronology: the next
  // replay compares this list too, including a tool inserted in an old gap.
  const beforeOrder = [...toolCalls];
  const rank = new Map(parts.filter((p) => p.kind === "tool").map((p, i) => [beforeOrder[p.toolIndex]!.id, i]));
  toolCalls.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  parts = parts.map((p) => p.kind === "tool" ? { ...p, toolIndex: toolCalls.findIndex((t) => t.id === beforeOrder[p.toolIndex]!.id) } : p);
  // Thinking stays between the text/tool parts that bracketed it. Host
  // aggregates add separators, so compare the drawn blocks, not that field.
  const body = parts.filter((p) => p.kind !== "thinking");
  const thinkingSlots = (source: MessagePart[], sourceTools: ToolCall[], remap = false) => {
    const slots = new Map<number, Extract<MessagePart, { kind: "thinking" }>[]>();
    let at = 0;
    for (const [index, part] of source.entries()) {
      if (part.kind !== "thinking") { at++; continue; }
      let slot = at;
      if (remap) {
        // A recovered tool changes numeric slots. Anchor thinking to a tool
        // this copy actually saw, rather than duplicating it at an old index.
        const before = source.slice(0, index).filter((p) => p.kind !== "thinking");
        const prior = before.findLastIndex((p) => p.kind === "tool");
        const after = source.slice(index + 1).filter((p) => p.kind !== "thinking");
        const following = after.findIndex((p) => p.kind === "tool");
        const anchor = prior >= 0 ? before[prior] : following >= 0 ? after[following] : undefined;
        if (anchor?.kind === "tool") {
          const target = body.findIndex((p) => p.kind === "tool" && toolCalls[p.toolIndex]?.id === sourceTools[anchor.toolIndex]?.id);
          if (target >= 0) slot = prior >= 0 ? target + before.length - prior : target - following;
        }
      }
      slots.set(slot, [...(slots.get(slot) ?? []), part]);
    }
    return slots;
  };
  const slots = thinkingSlots(parts, toolCalls);
  for (const [at, blocks] of thinkingSlots(other.parts, other.toolCalls, true)) {
    const mine = slots.get(at) ?? [];
    if (blocks.reduce((n, p) => n + p.text.length, 0) > mine.reduce((n, p) => n + p.text.length, 0)) slots.set(at, blocks);
  }
  parts = body.flatMap((part, at) => [...(slots.get(at) ?? []), part]);
  parts.push(...(slots.get(body.length) ?? []));
  const thinking = parts.filter((p) => p.kind === "thinking").map((p) => p.text).join("") || undefined;
  // Questions by request: one either copy saw settled is settled, and one
  // only the page has drawn stays (its card is the reader's).
  const settled = (e: AskUserExchange) => e.answers !== undefined || e.cancelled === true || e.order !== undefined || e.formAnswers !== undefined;
  const asks = new Map((base.askUserExchanges ?? []).map((e) => [e.requestId, e]));
  for (const e of other.askUserExchanges ?? []) {
    const mine = asks.get(e.requestId);
    if (!mine || (settled(e) && !settled(mine))) asks.set(e.requestId, e);
  }
  const askUserExchanges = asks.size ? [...asks.values()] : undefined;
  return {
    ...base, toolCalls, parts, thinking, askUserExchanges,
    // Terminal history is authoritative even when the drawn text is longer.
    failure: m.failure ?? base.failure,
    retryOfTurnId: m.failure ? m.retryOfTurnId : base.retryOfTurnId,
    failureLive: m.failure ? undefined : base.failureLive,
    files: m.files ?? base.files,
    blocks: m.blocks ?? base.blocks,
    id: old.id, timestamp: old.timestamp, isStreaming: true,
    turnId: m.turnId, streamTurnId: old.turnId ?? old.streamTurnId,
  };
}

type TranscriptSliceSlice = Pick<ChatState,
  | "historyLoads"
  | "noteHistoryLoaded"
  | "setMessages"
  | "appendMessages"
  | "finishHistoryReplay"
>;

export function createTranscriptSlice(ctx: ChatSliceContext): TranscriptSliceSlice {
  const { set, mutateBuffer } = ctx;
  return {
    historyLoads: {},
    noteHistoryLoaded: (sessionId) =>
      set((state) => ({ historyLoads: { ...state.historyLoads, [sessionId]: (state.historyLoads[sessionId] ?? 0) + 1 } })),

    setMessages: (key, messages) =>
      set((state) => {
        if (key === null) {
          if (state.draft) revokeAttachmentUrls(state.draft.messages);
          return {
            draft: { ...emptyChat(), messages },
          };
        }
        const existing = state.buffers[key];
        const base = existing ? { messages: existing.messages, isStreaming: existing.isStreaming } : null;
        const drawn = base ? keepDrawnMessages(withKnownTurns(messages, base.messages), base) : { messages, isStreaming: false };
        if (existing) revokeAttachmentUrls(existing.messages, drawn.messages);
        // The first chunk of the host's history: whatever it holds, even
        // nothing, the transcript is the host's now (#1328).
        const buffers = {
          ...state.buffers,
          [key]: base
            ? { ...emptyChat(), ...drawn, replay: { base, received: messages }, historyConfirmed: true as const }
            : { ...emptyChat(), messages, historyConfirmed: true as const },
        };
        const restoreFailures = { ...state.restoreFailures };
        delete restoreFailures[key];
        return { buffers: evictStale(buffers, state.activeSessionId), restoreFailures };
      }),

    appendMessages: (key, messages) =>
      set((state) => {
        if (key === null) {
          const draft = state.draft ?? emptyChat();
          return { draft: { ...draft, messages: [...draft.messages, ...messages] } };
        }
        const existing = state.buffers[key] ?? emptyChat();
        if (existing.replay) {
          // A later chunk of the same replay: reconcile the whole replay so
          // far against the transcript it replaced, so a message the first
          // chunk kept back as still being written is not drawn twice. The
          // answer as it stands now (deltas since) is the live one.
          const { base, received } = existing.replay;
          const now = existing.messages.at(-1);
          const live = base.messages.at(-1);
          const current = now && live && now.id === live.id ? { ...base, messages: [...base.messages.slice(0, -1), now] } : base;
          const all = [...received, ...messages];
          const drawn = keepDrawnMessages(withKnownTurns(all, current.messages), current);
          revokeAttachmentUrls(existing.messages, drawn.messages);
          return {
            buffers: {
              ...state.buffers,
              [key]: { ...existing, ...drawn, replay: { base: current, received: all }, lastTouched: Date.now() },
            },
          };
        }
        return {
          buffers: {
            ...state.buffers,
            [key]: {
              ...existing,
              messages: [...existing.messages, ...messages],
              lastTouched: Date.now(),
            },
          },
        };
      }),

    finishHistoryReplay: (key, keepRunning) => mutateBuffer(key, (existing) => {
      if (!existing.replay) return {};
      // Running status cannot make a lagging replay authoritative over
      // the live answer and its already drawn prefix.
      if (keepRunning && existing.isStreaming) return { replay: undefined };
      const { base, received } = existing.replay;
      const now = existing.messages.at(-1);
      const live = base.messages.at(-1);
      // A full replay is already reconciled. Progress that opened another
      // message afterward is live, not an unreceived history suffix. A
      // lagging backend can also omit just the answer that was live before
      // the replay; retain that answer even if this status ends its turn.
      if (received.length >= base.messages.length || now?.id !== live?.id
        || (base.isStreaming && live?.isStreaming && received.length === base.messages.length - 1
          && existing.messages.slice(0, received.length).every((m, i) => m.id === base.messages[i]!.id))) {
        return { replay: undefined };
      }
      const drawn = keepDrawnMessages(withKnownTurns(received, existing.messages), existing, false);
      revokeAttachmentUrls(existing.messages, drawn.messages);
      return { ...drawn, replay: undefined };
    }),
  };
}
