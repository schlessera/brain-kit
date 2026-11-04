/**
 * Approvals (#1361): tool-permission cards — the request, its decision,
 * the voice-permission receipt, and the closure, reopening and revocation of
 * cards restored from history.
 */
import { POLICY_CHANGE_REVIEW_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { ChatMessage, ChatState, SessionChat, ToolCall } from "../chat-state.js";
import type { ChatSliceContext } from "./buffers.js";

type ApprovalsSliceSlice = Pick<ChatState,
  | "requestToolApproval"
  | "applyVoicePermission"
  | "resolveToolApproval"
  | "closeRestoredApprovals"
  | "reopenRestoredApprovals"
  | "revokeRestoredApprovals"
>;

export function createApprovalsSlice(ctx: ChatSliceContext): ApprovalsSliceSlice {
  const { set, get, nextId, mutateBuffer, mutateToolHolder } = ctx;
  return {
    requestToolApproval: (key, toolUseId, toolName, input, description, kind, rememberable, turnId) =>
      mutateBuffer(key, (chat) => {
        const msgs = [...chat.messages];
        const request = (previous: ToolCall | undefined, restored: boolean): ToolCall => ({
          id: toolUseId,
          name: toolName,
          input,
          inputJson: JSON.stringify(input, null, 2),
          status: "pending_approval",
          ...(kind ? { approvalKind: kind } : {}),
          ...(kind === "policy" && POLICY_CHANGE_REVIEW_SCHEMA.safeParse(input.policyReview).success ? { policyChange: POLICY_CHANGE_REVIEW_SCHEMA.parse(input.policyReview) } : {}),
          ...(rememberable === false ? { approvalRememberable: false } : {}),
          ...(description ? { approvalDescription: description } : {}),
          // A card already pending keeps what it was; anything else is
          // restored when it lands on a message no live turn is streaming.
          ...((previous?.status === "pending_approval" ? previous.restored : restored)
            ? { restored: true as const, ...(turnId ? { approvalTurnId: turnId } : {}) }
            : {}),
        });
        // One card per request: a re-delivery updates the card wherever it
        // is, and never draws a second one (#964).
        const holder = msgs.findLastIndex((m) => m.role === "assistant" && m.toolCalls.some((t) => t.id === toolUseId));
        if (holder !== -1) {
          const target = msgs[holder]!;
          msgs[holder] = {
            ...target,
            // A card the host already closed with a reason (#1072) stays
            // closed: a late duplicate of its request revives nothing.
            toolCalls: target.toolCalls.map((t) => t.id !== toolUseId || (t.readOnly && t.readOnly !== "unlisted") ? t : request(t, !target.isStreaming)),
          };
          return { messages: msgs };
        }
        // The turn's own answer, when a message carries its id; otherwise
        // the latest answer, if it is still streaming or comes after the
        // user's latest message, and no other turn owns it.
        let index = turnId ? msgs.findLastIndex((m) => m.role === "assistant" && m.turnId === turnId) : -1;
        if (index === -1) {
          const last = msgs.findLastIndex((m) => m.role === "assistant");
          const lastUser = msgs.findLastIndex((m) => m.role === "user");
          const candidate = last === -1 ? undefined : msgs[last]!;
          if (candidate && (candidate.isStreaming || last > lastUser) && (!candidate.turnId || !turnId || candidate.turnId === turnId)) {
            index = last;
          }
        }
        if (index === -1) {
          // No answer belongs to this turn: the replay ended on the user's
          // message. Draw the turn's shell, holding only the card, with no
          // invented text (D52 §4, approval recovery).
          msgs.push({
            id: nextId(),
            role: "assistant",
            content: "",
            toolCalls: [request(undefined, true)],
            parts: [{ kind: "tool", toolIndex: 0 }],
            isStreaming: false,
            timestamp: Date.now(),
            turnShell: true,
            ...(turnId ? { turnId } : {}),
          });
          return { messages: msgs };
        }
        const last = msgs[index]!;
        // Check if tool call already exists (from streaming)
        const existingIdx = last.toolCalls.findIndex(
          (t) => t.name === toolName && t.status === "streaming"
        );
        const tools = [...last.toolCalls];
        const toolCall = request(undefined, !last.isStreaming);
        let parts = last.parts;
        if (existingIdx >= 0) {
          tools[existingIdx] = toolCall;
        } else {
          // Approval request for a tool that never streamed a start event —
          // give it a chronological slot too.
          parts = [...parts, { kind: "tool", toolIndex: tools.length }];
          tools.push(toolCall);
        }
        msgs[index] = { ...last, toolCalls: tools, parts };
        return { messages: msgs };
      }),

    applyVoicePermission: (receipt) => {
      const key = receipt.sessionId;
      const chat = get().buffers[key];
      const owns = (m: ChatMessage, t: ToolCall) => t.id === receipt.toolUseId && (t.approvalTurnId ?? m.turnId ?? m.streamTurnId) === receipt.turnId;
      if (!chat?.messages.some(m => m.toolCalls.some(t => owns(m, t) && t.voicePermission !== receipt))) return;
      mutateBuffer(key, current => ({ messages: current.messages.map(m => ({ ...m, toolCalls: m.toolCalls.map(t => {
        if (!owns(m, t)) return t;
        // Receipt state locks decisions through awaitsDecision. Preserve the
        // transcript status so ordinary result/recovery routing can still
        // recognize an unanswered restored card and record its closure.
        return { ...t, voicePermission: receipt };
      }) })) }));
    },

    resolveToolApproval: (key, toolUseId, approved) =>
      mutateToolHolder(key, toolUseId, (last) => ({
        ...last,
        toolCalls: last.toolCalls.map((t) =>
          t.id === toolUseId
            ? {
              ...t,
              status: approved ? ("approved" as const) : ("denied" as const),
              // Don't let approval wait time inflate the duration badge
              ...(approved ? { startedAt: Date.now() } : {}),
            }
            : t
        ),
      })),

    closeRestoredApprovals: (key, closures) => {
      if (closures.length === 0) return;
      const byId = new Map(closures.map((c) => [c.toolUseId, c.closure]));
      mutateBuffer(key, (chat) => {
        let changed = false;
        const messages = chat.messages.map((m) => {
          if (m.role !== "assistant" || !m.toolCalls.some((t) => byId.has(t.id))) return m;
          let touched = false;
          const toolCalls = m.toolCalls.map((t) => {
            const closure = byId.get(t.id);
            if (!closure || !t.restored || t.readOnly === closure) return t;
            // Decided on this page: the card already says what happened.
            if (t.status === "approved" || t.status === "denied") return t;
            if (t.readOnly && t.readOnly !== "unlisted") return t;
            touched = true;
            return { ...t, readOnly: closure };
          });
          if (!touched) return m;
          changed = true;
          return { ...m, toolCalls };
        });
        return changed ? { messages } : {};
      });
    },

    reopenRestoredApprovals: (key, toolUseIds) => {
      const reopen = (t: ToolCall) => toolUseIds.includes(t.id) && t.readOnly === "unlisted" && t.status === "pending_approval";
      const chat = key === null ? get().draft : get().buffers[key];
      if (!chat?.messages.some((m) => m.toolCalls.some(reopen))) return;
      mutateBuffer(key, (current) => ({
        messages: current.messages.map((m) => {
          if (!m.toolCalls.some(reopen)) return m;
          return { ...m, toolCalls: m.toolCalls.map((t) => {
            if (!reopen(t)) return t;
            const { readOnly: _closed, ...open } = t;
            return open;
          }) };
        }),
      }));
    },

    revokeRestoredApprovals: () =>
      set((state) => {
        const revoke = (chat: SessionChat): SessionChat => {
          if (!chat.messages.some((m) => m.toolCalls.some((t) => t.restored && t.readOnly !== "revoked"))) return chat;
          const messages = chat.messages.map((m) => {
            if (!m.toolCalls.some((t) => t.restored && t.readOnly !== "revoked")) return m;
            const toolCalls = m.toolCalls.map((t) => {
              if (!t.restored || t.readOnly === "revoked") return t;
              // The request's identity goes with the authority to answer
              // it: the card keeps only what it showed.
              const { approvalTurnId: _turn, ...rest } = t;
              return { ...rest, id: `revoked-${nextId()}`, readOnly: "revoked" as const };
            });
            if (!m.turnShell) return { ...m, toolCalls };
            const { turnId: _shellTurn, ...shell } = m;
            return { ...shell, toolCalls };
          });
          return { ...chat, messages };
        };
        const buffers = Object.fromEntries(Object.entries(state.buffers).map(([id, chat]) => [id, revoke(chat)]));
        const changed = Object.keys(buffers).some((id) => buffers[id] !== state.buffers[id]);
        const draft = state.draft ? revoke(state.draft) : state.draft;
        if (!changed && draft === state.draft) return state;
        return { buffers, draft };
      }),
  };
}
