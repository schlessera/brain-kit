/**
 * Streaming (#1361): how a turn's stream ends — finished, failed or
 * retrying — and what arrives after its text: blocks, the journal receipt
 * and promoted-link rewrites.
 */
import { rewriteLinkDestinations } from "@schlessera/brain-ui-sdk/internal/client";
import { rebaseBlocks, rewriteTexts } from "../../lib/promoted-links.js";
import type { ChatMessage, ChatState } from "../chat-state.js";
import type { ChatSliceContext } from "./buffers.js";
import { withoutRetry } from "./buffers.js";
import { textsOf } from "./transcript.js";

export type StreamingSliceSlice = Pick<ChatState,
  | "finishAssistantMessage"
  | "failAssistantMessage"
  | "setTurnNotice"
  | "setRetry"
  | "setMessageBlocks"
  | "setTurnJournal"
  | "rewriteMessageLinks"
  | "stampTurn"
  | "setStreaming"
>;

export function createStreamingSlice(ctx: ChatSliceContext): StreamingSliceSlice {
  const { nextId, mutateBuffer, mutateLastAssistant } = ctx;
  return {
    finishAssistantMessage: (key) =>
      mutateLastAssistant(
        key,
        (last) => ({ ...withoutRetry(last), isStreaming: false }),
        () => ({ isStreaming: false })
      ),

    failAssistantMessage: (key, failure, turnId, replace = false) =>
      mutateBuffer(
        key,
        (chat) => {
          const msgs = [...chat.messages];
          let index = -1;
          if (turnId) {
            index = msgs.findLastIndex((m) => m.role === "assistant" && m.turnId === turnId);
          }
          if (index === -1) {
            // The composer opens the turn's message before the turn has an
            // id, and a failure with no deltas never stamps one — so the
            // last assistant message, unless another turn owns it.
            const last = msgs.findLastIndex((m) => m.role === "assistant");
            const owner = last === -1 ? undefined : msgs[last].turnId;
            if (last !== -1 && (owner === undefined || owner === turnId)) index = last;
          }
          if (index === -1) {
            msgs.push({
              id: nextId(),
              role: "assistant",
              content: "",
              toolCalls: [],
              parts: [],
              isStreaming: false,
              timestamp: Date.now(),
              ...(turnId ? { turnId } : {}),
            });
            index = msgs.length - 1;
          }
          const target = msgs[index];
          msgs[index] = {
            ...withoutRetry(target),
            isStreaming: false,
            failure: target.failure && !replace ? target.failure : failure,
            failureLive: true,
            ...(turnId ? { turnId } : {}),
          };
          // The buffer streams while its newest message does: a follow-up
          // already running after this message keeps it streaming.
          const streaming = msgs.some((m) => m.role === "assistant" && m.isStreaming);
          return { messages: msgs, isStreaming: streaming };
        },
        true
      ),

    setTurnNotice: (key, notice, turnId) =>
      mutateBuffer(key, (chat) => {
        const msgs = [...chat.messages];
        let index = turnId ? msgs.findLastIndex((m) => m.role === "assistant" && (m.turnId ?? m.streamTurnId) === turnId) : -1;
        if (index === -1) {
          // As failAssistantMessage: the last assistant message, unless
          // another turn owns it.
          const last = msgs.findLastIndex((m) => m.role === "assistant");
          const owner = last === -1 ? undefined : msgs[last].turnId ?? msgs[last].streamTurnId;
          if (last !== -1 && (owner === undefined || owner === turnId)) index = last;
        }
        if (index !== -1 && (msgs[index].failure || msgs[index].runtimeNotice?.cause === notice.cause)) return {};
        if (index === -1) {
          msgs.push({
            id: nextId(),
            role: "assistant",
            content: "",
            toolCalls: [],
            parts: [],
            isStreaming: false,
            timestamp: Date.now(),
            ...(turnId ? { turnId } : {}),
          });
          index = msgs.length - 1;
        }
        msgs[index] = { ...msgs[index], runtimeNotice: notice, runtimeNoticeLive: true };
        return { messages: msgs };
      }),

    setRetry: (key, retry) =>
      mutateLastAssistant(key, (last) => {
        if (!last.isStreaming) return last;
        return retry ? { ...last, retry } : withoutRetry(last);
      }),

    setMessageBlocks: (key, blocks, turnId) =>
      mutateBuffer(key, (chat) => {
        const msgs = [...chat.messages];
        let index = -1;
        if (turnId) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant" && msgs[i].turnId === turnId) {
              index = i;
              break;
            }
          }
        }
        if (index === -1) {
          // No message carries the turn (an optimistic message opened by
          // the composer, or a frame without one): the last assistant
          // message, but only once it has finished — never a follow-up
          // still streaming.
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              if (!msgs[i].isStreaming) index = i;
              break;
            }
          }
        }
        if (index === -1) return {};
        // Blocks are anchored to the streamed text: after promoted links
        // rewrote it (#1698), they follow the rewrite.
        const rewrite = msgs[index].linkRewrite;
        msgs[index] = rewrite
          ? { ...msgs[index], blocks: rebaseBlocks(blocks, rewriteTexts(rewrite.texts, rewrite.links).map((result) => result.edits)),
            linkRewrite: { ...rewrite, blocks } }
          : { ...msgs[index], blocks };
        return { messages: msgs };
      }),

    setTurnJournal: (key, turnId, journal) => mutateBuffer(key, chat => ({ journals: { ...chat.journals, [turnId]: journal } }), true),

    rewriteMessageLinks: (key, links, turnId) =>
      mutateBuffer(key, (chat) => {
        if (links.length === 0) return {};
        const ofTurn = (m: ChatMessage) => m.role === "assistant" && !!turnId && (m.turnId ?? m.streamTurnId) === turnId;
        let targets = chat.messages.filter(ofTurn);
        if (targets.length === 0) {
          // A message the composer opened before any turn was named.
          const last = chat.messages.findLast((m) => m.role === "assistant");
          if (last && !(last.turnId ?? last.streamTurnId)) targets = [last];
        }
        let changed = false;
        const msgs = chat.messages.map((m) => {
          if (!targets.includes(m)) return m;
          const current = textsOf(m);
          // Always from the streamed text, so every edit is in its offsets.
          const base = m.linkRewrite && m.linkRewrite.texts.length === current.length
            ? m.linkRewrite
            : { texts: current, links: {}, ...(m.blocks ? { blocks: m.blocks } : {}) };
          const merged = { ...base.links, ...Object.fromEntries(links.map((link) => [link.from, link.to])) };
          const results = rewriteTexts(base.texts, merged);
          if (results.every((result, k) => result.text === current[k])) return m;
          changed = true;
          let k = 0;
          const parts = m.parts.map((part) => (part.kind === "text" ? { ...part, text: results[k++]!.text } : part));
          const texts = results.map((result) => result.text);
          const map = new Map(Object.entries(merged));
          // Live, the aggregate is the parts joined; otherwise rewrite it as it is.
          const content = m.content === current.join("")
            ? texts.join("")
            : rewriteLinkDestinations(m.content, (destination) => map.get(destination) ?? destination);
          const blocks = base.blocks ? rebaseBlocks(base.blocks, results.map((result) => result.edits)) : undefined;
          return { ...m, content, parts, ...(blocks ? { blocks } : {}), linkRewrite: { ...base, links: merged } };
        });
        return changed ? { messages: msgs } : {};
      }),

    stampTurn: (key, turnId) =>
      mutateLastAssistant(key, (last) =>
        last.isStreaming && !last.turnId ? { ...last, turnId } : last
      ),

    setStreaming: (key, streaming) => mutateBuffer(key, () => ({ isStreaming: streaming })),
  };
}
