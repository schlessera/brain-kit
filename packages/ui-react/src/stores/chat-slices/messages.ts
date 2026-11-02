/**
 * Messages (#1361): the user's message, the assistant's streamed text,
 * thinking and tool calls, and the per-message annotations a turn adds
 * while it runs.
 */
import type { ChatState, SessionChat } from "../chat-state.js";
import type { ChatSliceContext } from "./buffers.js";
import { appendPart, withoutRetry } from "./buffers.js";

export type MessagesSliceSlice = Pick<ChatState,
  | "setMessageEffort"
  | "setRetryHandle"
  | "addUserMessage"
  | "startAssistantMessage"
  | "appendText"
  | "setStatsAnswer"
  | "setLocalExchange"
  | "markLocalExchange"
  | "appendThinking"
  | "startToolCall"
  | "appendToolInput"
  | "completeToolCall"
  | "setToolResult"
>;

export function createMessagesSlice(ctx: ChatSliceContext): MessagesSliceSlice {
  const { set, nextId, mutateBuffer, mutateToolHolder, mutateLastAssistant } = ctx;
  return {
    setMessageEffort(key, requestId, thinkingLevel, effectiveThinkingLevel) {
      mutateBuffer(key, (chat) => ({ messages: chat.messages.map((message) => message.role === "user" && message.requestId === requestId
        ? { ...message, thinkingLevel, ...(effectiveThinkingLevel !== undefined ? { effectiveThinkingLevel } : {}) } : message) }));
    },

    setRetryHandle: (key, retryOfTurnId) => mutateLastAssistant(key, last => ({ ...last, retryOfTurnId })),

    // createIfMissing: a user-initiated send must never be dropped, even when
    // the active session's buffer hasn't been materialized yet (cold start
    // racing the history replay).
    addUserMessage: (key, text, source, attachments, effort, files) =>
      mutateBuffer(
        key,
        (chat) => ({
          messages: [
            ...chat.messages,
            {
              id: nextId(),
              role: "user",
              content: text,
              toolCalls: [],
              parts: [],
              isStreaming: false,
              timestamp: Date.now(),
              source: source ?? "typed",
              ...effort,
              ...(files?.length ? { files } : {}),
              ...(attachments && attachments.length > 0
                ? { attachments, attachmentCount: attachments.length }
                : {}),
            },
          ],
        }),
        true
      ),

    startAssistantMessage: (key, turnId, requestId) =>
      mutateBuffer(key, (chat) => ({
        messages: [
          ...chat.messages,
          {
            id: nextId(),
            role: "assistant",
            content: "",
            thinking: "",
            toolCalls: [],
            parts: [],
            isStreaming: true,
            timestamp: Date.now(),
            ...(turnId ? { turnId } : {}),
            ...(requestId ? { requestId } : {}),
          },
        ],
        isStreaming: true,
      })),

    appendText: (key, text) =>
      mutateLastAssistant(key, (last) => ({
        ...withoutRetry(last),
        content: last.content + text,
        parts: appendPart(last.parts, "text", text),
      })),

    setStatsAnswer: (key, sections) =>
      mutateLastAssistant(key, (last) => ({ ...last, statsAnswer: sections })),

    setLocalExchange: (key, exchange) =>
      mutateLastAssistant(key, (last) => ({ ...last, localExchange: exchange })),

    markLocalExchange: (exchangeId, saved, reason) =>
      set((state) => {
        const mark = (chat: SessionChat): SessionChat | null => {
          const index = chat.messages.findIndex((m) => m.localExchange?.id === exchangeId);
          if (index === -1) return null;
          const messages = [...chat.messages];
          const current = messages[index]!;
          const { reason: _previous, ...exchange } = current.localExchange!;
          messages[index] = {
            ...current,
            localExchange: { ...exchange, saved, ...(reason ? { reason } : {}) },
          };
          return { ...chat, messages };
        };
        const draft = state.draft ? mark(state.draft) : null;
        if (draft) return { draft };
        for (const [key, chat] of Object.entries(state.buffers)) {
          const marked = mark(chat);
          if (marked) return { buffers: { ...state.buffers, [key]: marked } };
        }
        return state;
      }),

    appendThinking: (key, text) =>
      mutateLastAssistant(key, (last) => ({
        ...withoutRetry(last),
        thinking: (last.thinking || "") + text,
        parts: appendPart(last.parts, "thinking", text),
      })),

    startToolCall: (key, toolUseId, toolName) =>
      mutateLastAssistant(key, (last) => ({
        ...last,
        parts: [...last.parts, { kind: "tool", toolIndex: last.toolCalls.length }],
        toolCalls: [
          ...last.toolCalls,
          {
            id: toolUseId,
            name: toolName,
            input: {},
            inputJson: "",
            status: "streaming",
            startedAt: Date.now(),
          },
        ],
      })),

    appendToolInput: (key, partialJson) =>
      mutateLastAssistant(key, (last) => {
        if (last.toolCalls.length === 0) return last;
        const tools = [...last.toolCalls];
        const lastTool = tools[tools.length - 1];
        tools[tools.length - 1] = {
          ...lastTool,
          inputJson: lastTool.inputJson + partialJson,
        };
        return { ...last, toolCalls: tools };
      }),

    completeToolCall: (key, toolUseId, toolName, input) =>
      mutateLastAssistant(key, (last) => ({
        ...last,
        toolCalls: last.toolCalls.map((t) =>
          t.id === toolUseId || (t.name === toolName && t.status === "streaming")
            ? {
              ...t,
              id: toolUseId,
              input,
              status: "complete" as const,
              // Input finished streaming — execution starts about now
              startedAt: Date.now(),
            }
            : t
        ),
      })),

    setToolResult: (key, toolUseId, output, isError, policyChange) =>
      mutateToolHolder(key, toolUseId, (last) => ({
        ...last,
        toolCalls: last.toolCalls.map((t) =>
          t.id === toolUseId
            ? {
              ...t,
              output,
              isError,
              ...(policyChange ? { policyChange } : {}),
              status: "complete" as const,
              endedAt: Date.now(),
            }
            : t
        ),
      })),
  };
}
