/**
 * Approvals (#1361, #4966, #3595, #4967): tool-permission cards, the open
 * chat's network approval stack (with in-place revision updates and host-owned
 * terminal receipts), active session network grants, and restored-card closure.
 */
import type { NetworkApprovalOffer, ServerToolResolution } from "@schlessera/brain-ui-sdk/protocol";
import { POLICY_CHANGE_REVIEW_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import type {
  ChatKey,
  ChatMessage,
  ChatState,
  NetworkApprovalReceipt,
  PendingNetworkApproval,
  SessionChat,
  ToolCall,
} from "../chat-state.js";
import type { ChatSliceContext } from "./buffers.js";

type ApprovalsSliceSlice = Pick<ChatState,
  | "networkGrants"
  | "setNetworkGrants"
  | "markNetworkApprovalSending"
  | "resetNetworkApprovalSending"
  | "applyToolResolution"
  | "requestToolApproval"
  | "applyVoicePermission"
  | "resolveToolApproval"
  | "closeRestoredApprovals"
  | "reopenRestoredApprovals"
  | "revokeRestoredApprovals"
>;

/** Human-readable short origin label (distinguishes non-default ports & CONNECT tunnels). */
export function formatNetworkOriginLabel(
  origin: string | undefined,
  network: NetworkApprovalOffer | undefined,
  input: Record<string, unknown>
): string {
  if (network) {
    const defaultPort = (network.scheme === "http" && network.port === 80)
      || ((network.scheme === "https" || network.scheme === "connect") && network.port === 443);
    const hostPort = defaultPort ? network.host : `${network.host}:${network.port}`;
    return network.transport === "connect" && !network.managedReference
      ? `${hostPort} · tunnel`
      : hostPort;
  }
  if (typeof input.host === "string" && input.host.length > 0) {
    const port = typeof input.port === "number" ? input.port : undefined;
    return port && port !== 80 && port !== 443 ? `${input.host}:${port}` : input.host;
  }
  return origin ?? "network";
}

function receiptFromResolution(
  msg: ServerToolResolution,
  existing: PendingNetworkApproval | undefined,
  nextId: () => string
): NetworkApprovalReceipt {
  const origin = existing?.origin ?? msg.toolUseId;
  const originLabel = existing?.originLabel ?? (msg.reason?.match(/for ([^\s]+)/)?.[1] ?? "network");
  let state: NetworkApprovalReceipt["state"];
  let reason = msg.reason;
  if (msg.outcome === "granted") {
    state = "granted";
  } else if (msg.outcome === "unknown") {
    state = "unknown";
    reason = "This request had already closed — nothing ran";
  } else if (msg.outcome === "denied") {
    state = "withdrawn";
    reason = msg.reason || `Denied · ${originLabel}`;
  } else if (msg.expiryCause === "operation_cancelled") {
    state = "withdrawn";
    reason = `Withdrawn · ${originLabel} stopped waiting`;
  } else {
    state = "expired";
    reason = msg.reason || `Expired · ${originLabel} · chat turn ended`;
  }
  return {
    id: nextId(),
    toolUseId: msg.toolUseId,
    ...(msg.turnId ?? existing?.turnId ? { turnId: msg.turnId ?? existing?.turnId } : {}),
    origin,
    originLabel,
    state,
    ...(msg.networkScope ? { scope: msg.networkScope } : msg.outcome === "granted" ? { scope: "legacy" as const } : {}),
    ...(msg.grantedByGrant ? { grantedByGrant: true } : {}),
    ...(reason ? { reason } : {}),
    at: Date.now(),
  };
}

function appendReceipt(
  current: readonly NetworkApprovalReceipt[] | undefined,
  receipt: NetworkApprovalReceipt
): NetworkApprovalReceipt[] {
  const list = [...(current ?? [])];
  const idx = list.findIndex((r) => r.toolUseId === receipt.toolUseId);
  if (idx >= 0) {
    // Idempotent upgrade: e.g., provisional expired replaced by terminal expired with cause/reason.
    list[idx] = { ...list[idx]!, ...receipt, id: list[idx]!.id };
    return list;
  }
  return [...list.slice(-99), receipt];
}

export function createApprovalsSlice(ctx: ChatSliceContext): ApprovalsSliceSlice {
  const { set, get, nextId, mutateBuffer, mutateToolHolder } = ctx;
  return {
    networkGrants: {},
    setNetworkGrants: (sessionId, grants) =>
      set((state) => ({
        networkGrants: { ...state.networkGrants, [sessionId]: grants },
      })),

    markNetworkApprovalSending: (key, toolUseId, scope) =>
      mutateBuffer(key, (chat) => {
        const list = chat.networkApprovals;
        if (!list?.some((item) => item.toolUseId === toolUseId)) return {};
        return {
          networkApprovals: list.map((item) =>
            item.toolUseId === toolUseId
              ? { ...item, sending: true, ...(scope ? { sendingScope: scope } : {}) }
              : item
          ),
        };
      }),

    resetNetworkApprovalSending: (key, toolUseId) =>
      mutateBuffer(key, (chat) => {
        const list = chat.networkApprovals;
        if (!list?.some((item) => item.toolUseId === toolUseId && item.sending)) return {};
        return {
          networkApprovals: list.map((item) => {
            if (item.toolUseId !== toolUseId) return item;
            const { sending: _s, sendingScope: _sc, ...rest } = item;
            return rest;
          }),
        };
      }),

    applyToolResolution: (msg) => {
      const state = get();
      const candidateKeys: ChatKey[] = msg.sessionId !== undefined
        ? [msg.sessionId]
        : [
            ...(state.activeSessionId ? [state.activeSessionId] : []),
            ...Object.keys(state.buffers).filter((k) => k !== state.activeSessionId),
            null,
          ];
      let matchedKey: ChatKey | undefined;
      let matchedItem: PendingNetworkApproval | undefined;
      for (const k of candidateKeys) {
        const buf = k === null ? state.draft : state.buffers[k];
        const found = buf?.networkApprovals?.find((item) => item.toolUseId === msg.toolUseId);
        if (found) {
          matchedKey = k;
          matchedItem = found;
          break;
        }
      }
      if (matchedKey !== undefined && matchedItem) {
        const receipt = receiptFromResolution(msg, matchedItem, nextId);
        mutateBuffer(matchedKey, (chat) => ({
          networkApprovals: (chat.networkApprovals ?? []).filter((item) => item.toolUseId !== msg.toolUseId),
          networkReceipts: appendReceipt(chat.networkReceipts, receipt),
        }));
        return;
      }
      // Standalone standing-grant receipt or idempotent upgrade of an already-recorded receipt.
      if (msg.sessionId && (msg.grantedByGrant || state.buffers[msg.sessionId]?.networkReceipts?.some((r) => r.toolUseId === msg.toolUseId))) {
        const receipt = receiptFromResolution(msg, undefined, nextId);
        mutateBuffer(msg.sessionId, (chat) => ({
          networkReceipts: appendReceipt(chat.networkReceipts, receipt),
        }));
        return;
      }
      // Also settle ordinary tool cards if the host resolved them (e.g. expired/unknown) without a tool_result.
      for (const k of candidateKeys) {
        const buf = k === null ? state.draft : state.buffers[k];
        if (!buf?.messages.some((m) => m.toolCalls.some((t) => t.id === msg.toolUseId && (t.status === "pending_approval" || t.approvalSending)))) {
          continue;
        }
        mutateToolHolder(k, msg.toolUseId, (holder) => ({
          ...holder,
          toolCalls: holder.toolCalls.map((t) => {
            if (t.id !== msg.toolUseId) return t;
            const nextStatus = msg.outcome === "granted" ? ("approved" as const) : ("denied" as const);
            return {
              ...t,
              status: nextStatus,
              approvalSending: false,
              ...(msg.outcome === "granted" ? { startedAt: Date.now() } : {}),
            };
          }),
        }));
        break;
      }
    },

    requestToolApproval: (key, toolUseId, toolName, input, description, kind, rememberable, turnId, display, meta) =>
      mutateBuffer(key, (chat) => {
        // Network taint approval cards live in the open chat's pinned stack (#4967),
        // never creating synthetic `Network` rows in the transcript.
        const isNetworkStackCard = toolName === "Network" && Boolean(meta?.network || meta?.origin);
        if (isNetworkStackCard) {
          const now = Date.now();
          const list = [...(chat.networkApprovals ?? [])];
          const idx = list.findIndex((item) => item.toolUseId === toolUseId);
          const origin = meta?.origin ?? (typeof input.target === "string" ? input.target : toolUseId);
          const originLabel = formatNetworkOriginLabel(origin, meta?.network, input);
          if (idx >= 0) {
            const prev = list[idx]!;
            if (prev.readOnly && prev.readOnly !== "unlisted") return {};
            const revisionChanged = meta?.revision !== undefined && meta.revision !== prev.revision;
            const { sending: _s, sendingScope: _sc, ...basePrev } = prev;
            list[idx] = {
              ...basePrev,
              input,
              origin,
              originLabel,
              ...(description !== undefined ? { description } : {}),
              ...(turnId !== undefined ? { turnId } : {}),
              ...(meta?.revision !== undefined ? { revision: meta.revision } : {}),
              ...(meta?.network !== undefined ? { network: meta.network } : {}),
              updatedAt: revisionChanged ? now : prev.updatedAt,
              revisionCount: revisionChanged ? prev.revisionCount + 1 : prev.revisionCount,
            };
            return { networkApprovals: list };
          }
          const restored = !chat.isStreaming ? (true as const) : undefined;
          list.push({
            toolUseId,
            toolName,
            input,
            ...(description !== undefined ? { description } : {}),
            ...(turnId !== undefined ? { turnId } : {}),
            origin,
            originLabel,
            ...(meta?.revision !== undefined ? { revision: meta.revision } : {}),
            ...(meta?.network !== undefined ? { network: meta.network } : {}),
            createdAt: now,
            updatedAt: now,
            revisionCount: 1,
            ...(restored ? { restored } : {}),
          });
          return { networkApprovals: list };
        }

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
          ...(display ? { approvalDisplay: display } : {}),
          ...(meta?.revision ? { approvalRevision: meta.revision } : {}),
          ...(meta?.origin ? { approvalOrigin: meta.origin } : {}),
          ...(meta?.network ? { approvalNetwork: meta.network } : {}),
          ...((previous?.status === "pending_approval" ? previous.restored : restored)
            ? { restored: true as const, ...(turnId ? { approvalTurnId: turnId } : {}) }
            : {}),
        });
        const holder = msgs.findLastIndex((m) => m.role === "assistant" && m.toolCalls.some((t) => t.id === toolUseId));
        if (holder !== -1) {
          const target = msgs[holder]!;
          msgs[holder] = {
            ...target,
            toolCalls: target.toolCalls.map((t) => t.id !== toolUseId || (t.readOnly && t.readOnly !== "unlisted") ? t : request(t, !target.isStreaming)),
          };
          return { messages: msgs };
        }
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
        const existingIdx = last.toolCalls.findIndex(
          (t) => t.name === toolName && t.status === "streaming"
        );
        const tools = [...last.toolCalls];
        const toolCall = request(undefined, !last.isStreaming);
        let parts = last.parts;
        if (existingIdx >= 0) {
          tools[existingIdx] = toolCall;
        } else {
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
      mutateBuffer(key, current => ({ messages: current.messages.map(m => !m.toolCalls.some(t => owns(m, t) && t.voicePermission !== receipt) ? m : { ...m, toolCalls: m.toolCalls.map(t => {
        if (!owns(m, t) || t.voicePermission === receipt) return t;
        return { ...t, voicePermission: receipt };
      }) }) }));
    },

    resolveToolApproval: (key, toolUseId, approved) =>
      mutateToolHolder(key, toolUseId, (last) => ({
        ...last,
        toolCalls: last.toolCalls.map((t) =>
          t.id === toolUseId
            ? {
              ...t,
              status: approved ? ("approved" as const) : ("denied" as const),
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
            if (t.status === "approved" || t.status === "denied") return t;
            if (t.readOnly && t.readOnly !== "unlisted") return t;
            touched = true;
            return { ...t, readOnly: closure };
          });
          if (!touched) return m;
          changed = true;
          return { ...m, toolCalls };
        });
        let netChanged = false;
        const networkApprovals = chat.networkApprovals?.map((item) => {
          const closure = byId.get(item.toolUseId);
          if (!closure || !item.restored || item.readOnly === closure) return item;
          if (item.readOnly && item.readOnly !== "unlisted") return item;
          netChanged = true;
          return { ...item, readOnly: closure };
        });
        return changed || netChanged
          ? { ...(changed ? { messages } : {}), ...(netChanged && networkApprovals ? { networkApprovals } : {}) }
          : {};
      });
    },

    reopenRestoredApprovals: (key, toolUseIds) => {
      const reopen = (t: ToolCall) => toolUseIds.includes(t.id) && t.readOnly === "unlisted" && t.status === "pending_approval";
      const reopenNet = (item: PendingNetworkApproval) => toolUseIds.includes(item.toolUseId) && item.readOnly === "unlisted";
      const chat = key === null ? get().draft : get().buffers[key];
      const hasTool = chat?.messages.some((m) => m.toolCalls.some(reopen));
      const hasNet = chat?.networkApprovals?.some(reopenNet);
      if (!hasTool && !hasNet) return;
      mutateBuffer(key, (current) => ({
        ...(hasTool ? {
          messages: current.messages.map((m) => {
            if (!m.toolCalls.some(reopen)) return m;
            return {
              ...m,
              toolCalls: m.toolCalls.map((t) => {
                if (!reopen(t)) return t;
                const { readOnly: _closed, ...open } = t;
                return open;
              }),
            };
          }),
        } : {}),
        ...(hasNet && current.networkApprovals ? {
          networkApprovals: current.networkApprovals.map((item) => {
            if (!reopenNet(item)) return item;
            const { readOnly: _closed, ...open } = item;
            return open;
          }),
        } : {}),
      }));
    },

    revokeRestoredApprovals: () =>
      set((state) => {
        const revoke = (chat: SessionChat): SessionChat => {
          const hasTool = chat.messages.some((m) => m.toolCalls.some((t) => t.restored && t.readOnly !== "revoked"));
          const hasNet = chat.networkApprovals?.some((item) => item.restored && item.readOnly !== "revoked");
          if (!hasTool && !hasNet) return chat;
          const messages = hasTool ? chat.messages.map((m) => {
            if (!m.toolCalls.some((t) => t.restored && t.readOnly !== "revoked")) return m;
            const toolCalls = m.toolCalls.map((t) => {
              if (!t.restored || t.readOnly === "revoked") return t;
              const { approvalTurnId: _turn, ...rest } = t;
              return { ...rest, id: `revoked-${nextId()}`, readOnly: "revoked" as const };
            });
            if (!m.turnShell) return { ...m, toolCalls };
            const { turnId: _shellTurn, ...shell } = m;
            return { ...shell, toolCalls };
          }) : chat.messages;
          const networkApprovals = hasNet && chat.networkApprovals
            ? chat.networkApprovals.map((item) => {
                if (!item.restored || item.readOnly === "revoked") return item;
                const { turnId: _t, ...rest } = item;
                return { ...rest, toolUseId: `revoked-${nextId()}`, readOnly: "revoked" as const };
              })
            : chat.networkApprovals;
          return { ...chat, messages, ...(networkApprovals ? { networkApprovals } : {}) };
        };
        const buffers = Object.fromEntries(Object.entries(state.buffers).map(([id, chat]) => [id, revoke(chat)]));
        const changed = Object.keys(buffers).some((id) => buffers[id] !== state.buffers[id]);
        const draft = state.draft ? revoke(state.draft) : state.draft;
        if (!changed && draft === state.draft) return state;
        return { buffers, draft };
      }),
  };
}
