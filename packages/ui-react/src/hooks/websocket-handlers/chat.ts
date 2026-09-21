import { activeChat } from "../../stores/chat-state.js";
import type { ChatMessage, ToolCall, AskUserExchange } from "../../stores/chat-store.js";
import type {
  AskUserQuestion,
  ServerMessage,
  SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import { isAskUserTool } from "../../lib/tool-names.js";
import type { ServerMessageHandlerMap } from "./types.js";

type ChatFrame =
  | "text_delta"
  | "thinking_delta"
  | "tool_use_start"
  | "tool_input_delta"
  | "tool_use_complete"
  | "tool_approval_request"
  | "tool_result"
  | "ask_user_request"
  | "result"
  | "message_blocks"
  | "session_history"
  | "status";

let historyMessageCounter = 0;
function historyId() {
  return `hist-${++historyMessageCounter}-${Date.now()}`;
}

function convertHistoryMessage(msg: SessionHistoryMessage): ChatMessage {
  // Fallback for history without chronological parts: synthesize the legacy
  // grouped order (thinking, tools, text).
  const parts =
    msg.parts ??
    [
      ...(msg.thinking ? [{ kind: "thinking", text: msg.thinking } as const] : []),
      ...msg.toolCalls.map((_, i) => ({ kind: "tool", toolIndex: i }) as const),
      ...(msg.content ? [{ kind: "text", text: msg.content } as const] : []),
    ];
  const askUserExchanges = reconstructAskUserExchanges(msg.toolCalls);
  return {
    id: historyId(),
    role: msg.role,
    content: msg.content,
    thinking: msg.thinking,
    toolCalls: msg.toolCalls.map((tc): ToolCall => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
      inputJson: JSON.stringify(tc.input, null, 2),
      output: tc.output,
      isError: tc.isError,
      status: "complete",
    })),
    parts,
    isStreaming: false,
    timestamp: Date.now(),
    ...(askUserExchanges ? { askUserExchanges } : {}),
    ...(msg.attachmentCount ? { attachmentCount: msg.attachmentCount } : {}),
    ...(msg.blocks && msg.blocks.length > 0 ? { blocks: msg.blocks } : {}),
  };
}

/**
 * Rebuild ask_user exchanges from a resumed message's tool calls.
 *
 * The persisted tool output is `{answers, annotations}` (Claude) or the bare
 * answers map (pi). Neither carries whether the answer was chosen from the
 * options or typed into the composer (`AskUserExchange.typed`), nor when it
 * was given, so a resumed exchange comes back as a plain `answered` one with
 * no time. Carrying `typed` would mean widening the `ask_user` response —
 * a `CONTRACT:` change — not guessing here.
 */
function isBareAnswersMap(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}

function reconstructAskUserExchanges(
  toolCalls: SessionHistoryMessage["toolCalls"]
): AskUserExchange[] | undefined {
  const exchanges: AskUserExchange[] = [];
  for (const tc of toolCalls) {
    if (!isAskUserTool(tc.name)) continue;
    const questions = (tc.input?.questions as AskUserQuestion[]) ?? [];
    const exchange: AskUserExchange = { requestId: tc.id, questions };
    if (tc.output) {
      try {
        const payload = JSON.parse(tc.output) as {
          answers?: Record<string, string>;
          annotations?: AskUserExchange["annotations"];
        };
        if (payload && typeof payload === "object" && payload.answers) {
          exchange.answers = payload.answers;
          exchange.annotations = payload.annotations;
        } else if (isBareAnswersMap(payload)) {
          // The pi backend persists the bare answers map, without the
          // `{answers}` envelope the Claude tool writes.
          exchange.answers = payload;
        }
      } catch {
        // Non-JSON output means the question was dismissed or errored out.
        exchange.cancelled = true;
      }
    }
    if (tc.isError && !exchange.answers) exchange.cancelled = true;
    exchanges.push(exchange);
  }
  return exchanges.length ? exchanges : undefined;
}

/** Map a frame to the run-state its session should show in the session list. */
export function runStateForFrame(msg: ServerMessage): "streaming" | "queued" | "idle" {
  if (msg.type === "result" || msg.type === "error") return "idle";
  if (msg.type === "status") {
    if (msg.status === "queued") return "queued";
    if (msg.status === "idle" || msg.status === "cancelled") return "idle";
  }
  return "streaming";
}

export const chatFrameHandlers = {
  text_delta: (msg, context) => {
    // Opening the bubble stays immediate — the first token should show a
    // message starting, and every later delta needs isStreaming to be true.
    if (!context.buffer()?.isStreaming) {
      context.state.startAssistantMessage(context.key, context.frameTurnId);
    }
    if (context.frameTurnId) context.state.stampTurn(context.key, context.frameTurnId);
    context.enqueueDelta(context.key, "text", msg.text);
  },
  thinking_delta: (msg, context) => {
    if (!context.buffer()?.isStreaming) {
      context.state.startAssistantMessage(context.key, context.frameTurnId);
    }
    if (context.frameTurnId) context.state.stampTurn(context.key, context.frameTurnId);
    context.enqueueDelta(context.key, "thinking", msg.text);
  },
  tool_use_start: (msg, context) => {
    // A tool call INSIDE a subagent nests under its Agent entry, rendered
    // from the activity stream — putting it in the flat transcript would
    // interleave fan-out work with the main turn's steps.
    if (msg.parentToolUseId) return;
    context.state.startToolCall(context.key, msg.toolUseId, msg.toolName);
  },
  tool_input_delta: (msg, context) => {
    context.state.appendToolInput(context.key, msg.partialJson);
  },
  tool_use_complete: (msg, context) => {
    // Subagent tool calls render nested (activity stream), and the flat
    // store's name-based fallback match must never see them.
    if (msg.parentToolUseId) return;
    context.state.completeToolCall(context.key, msg.toolUseId, msg.toolName, msg.input);
  },
  tool_approval_request: (msg, context) => {
    context.state.requestToolApproval(
      context.key,
      msg.toolUseId,
      msg.toolName,
      msg.input,
      msg.description,
      msg.kind
    );
  },
  tool_result: (msg, context) => {
    context.state.setToolResult(context.key, msg.toolUseId, msg.output, msg.isError);
    // Once the agent receives the ask_user tool result, the exchange is
    // complete — drop any leftover ask_user UI state.
    const chat = context.buffer();
    if (chat?.askUser?.answers || chat?.askUser?.cancelled) {
      context.state.clearAskUser(context.key);
    }
  },
  ask_user_request: (msg, context) => {
    context.state.setAskUserRequest(context.key, msg.requestId, msg.questions);
  },
  result: (msg, context) => {
    context.state.finishAssistantMessage(context.key);
    context.resyncIfNeeded(msg.sessionId);
  },
  message_blocks: (msg, context) => {
    // Arrives after `result`, for the turn's own assistant message. An
    // answer never waits on it: the markdown is already on screen, and this
    // only says which spans to draw as blocks (D42). Targeted by the turn
    // the frame belongs to: a queued follow-up may already have opened a
    // newer assistant message by the time the pass returns.
    context.state.setMessageBlocks(context.key, msg.blocks, context.frameTurnId);
  },
  session_history: (msg, context) => {
    const converted = msg.messages.map(convertHistoryMessage);
    if (msg.append) {
      context.state.appendMessages(context.key, converted);
    } else {
      // First (replacing) chunk = fresh authoritative transcript. Cancel any
      // pending reconnect resync so we don't redundantly re-fetch it, and
      // mark this session cold-resumed so idle-status handling doesn't loop.
      context.state.setMessages(context.key, converted);
      context.markHistoryReplaced(context.key);
    }
  },
  status: (msg, context) => {
    // Only finish streaming if this buffer actually started it
    if (
      (msg.status === "idle" || msg.status === "cancelled") &&
      context.buffer()?.isStreaming
    ) {
      context.state.finishAssistantMessage(context.key);
    }
    // A session that finished while we were offline never delivers its
    // `result` — the idle status on reconnect is the cue to resync. Keyed to
    // THIS frame's session: a background session settling must not consume
    // (or trigger) the active session's pending resync.
    if (msg.status === "idle" || msg.status === "cancelled") {
      const current = context.stores.chat.getState();
      context.resyncIfNeeded(context.frameSessionId ?? current.activeSessionId);
      // Cold load: we hold a stored session id but an empty transcript and
      // the server is idle (so it sent no snapshot). Fetch the history.
      // Only the active session's own (or an unscoped legacy) idle counts.
      if (!context.frameSessionId || context.frameSessionId === current.activeSessionId) {
        context.coldResumeIfNeeded(
          current.activeSessionId,
          activeChat(current).messages.length
        );
      }
    }
  },
} satisfies ServerMessageHandlerMap<ChatFrame>;
