import { ASK_USER_FORM_INPUT_SCHEMA } from "@schlessera/brain-ui-sdk/tool-contracts";
import { askUserFormSpec, askUserFormPayload } from "@schlessera/brain-ui-sdk/internal/client";
import { activeChat } from "../../stores/chat-state.js";
import type { ChatMessage, ToolCall, AskUserExchange } from "../../stores/chat-store.js";
import type {
  AskUserListSpec,
  AskUserRankSpec,
  AskUserFormSpec,
  AskUserQuestion,
  ServerMessage,
  SessionHistoryMessage,
  TurnFailure,
} from "@schlessera/brain-ui-sdk/protocol";
import { isAskUserFormTool, isAskUserListTool, isAskUserRankTool, isAskUserTool } from "../../lib/tool-names.js";
import { replayedStatsSections } from "../../lib/stats/context-text.js";
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
  | "ask_user_list_request"
  | "ask_user_rank_request"
  | "ask_user_form_request"
  | "result"
  | "retry_receipt"
  | "ask_answer_receipt"
  | "pong"
  | "message_blocks"
  | "local_exchange_result"
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
    ...(msg.files?.length ? { files: msg.files } : {}),
    ...(msg.attachmentCount ? { attachmentCount: msg.attachmentCount } : {}),
    ...(msg.blocks && msg.blocks.length > 0 ? { blocks: msg.blocks } : {}),
    // Absent means typed: an older host never sends it, and a newer one
    // leaves it off typed messages.
    ...(msg.role === "user" ? { source: msg.source ?? "typed" } : {}),
    ...(msg.role === "user" && msg.thinkingLevel !== undefined ? { thinkingLevel: msg.thinkingLevel, effectiveThinkingLevel: msg.effectiveThinkingLevel } : {}),
    ...localAnswerFields(msg),
    // The host-proven turn this answer ended (#964); never guessed.
    ...(msg.role === "assistant" && msg.turnId ? { turnId: msg.turnId } : {}),
    // The failure that ended the turn (#575), drawn as it was live.
    ...(msg.role === "assistant" && msg.failure ? { failure: msg.failure, retryOfTurnId: msg.retryOfTurnId } : {}),
  };
}

/**
 * What a failed turn shows when its terminal frame names no failure: an
 * older host, or a turn that stopped for a reason other than the provider.
 * Never nothing — an error outcome with an empty row is the bug (#191).
 */
function unreportedFailure(outcomeDetail: string | undefined): TurnFailure {
  return {
    errorClass: "unknown",
    message: outcomeDetail
      ? `The turn ended with an error (${outcomeDetail}).`
      : "The turn ended with an error.",
  };
}

/**
 * A replayed local exchange's answer (#582), drawn as it was live. An answer
 * for a command this client does not know, or one it cannot read, replays
 * as the empty assistant message it is on the wire.
 */
function localAnswerFields(msg: SessionHistoryMessage): Partial<ChatMessage> {
  const local = msg.role === "assistant" ? msg.localAnswer : undefined;
  if (!local || local.command !== "stats") return {};
  const sections = replayedStatsSections(local.answer);
  if (!sections) return {};
  return {
    statsAnswer: sections,
    localExchange: {
      id: local.exchangeId,
      command: local.command,
      prompt: "",
      answer: local.answer,
      context: "",
      saved: "saved",
    },
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
    if (isAskUserFormTool(tc.name)) { exchanges.push(reconstructFormExchange(tc)); continue; }
    if (isAskUserRankTool(tc.name)) {
      exchanges.push(reconstructRankExchange(tc));
      continue;
    }
    if (isAskUserListTool(tc.name)) {
      exchanges.push(reconstructListExchange(tc));
      continue;
    }
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

/**
 * The list request as the card drew it, from the tool call's own input, with
 * the tool's defaults applied. The persisted result carries only the answers
 * (`{answers, skipped, notes?}`), so the input is the one place the items and
 * the scale survive a reload.
 */
export function listSpecFromInput(input: Record<string, unknown> | undefined): AskUserListSpec {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const scale = (Array.isArray(input?.scale) ? input.scale : []).filter(record).flatMap((o) => {
    const label = str(o.label);
    const description = str(o.description);
    return label ? [{ label, ...(description ? { description } : {}) }] : [];
  });
  const items = (Array.isArray(input?.items) ? input.items : []).filter(record).flatMap((i) => {
    const id = str(i.id);
    const label = str(i.label);
    const detail = str(i.detail);
    const link = str(i.link);
    return id && label ? [{ id, label, ...(detail ? { detail } : {}), ...(link ? { link } : {}) }] : [];
  });
  return {
    prompt: str(input?.prompt) ?? "",
    scale,
    items,
    allowSkip: input?.allowSkip !== false,
    notes: input?.notes === true,
  };
}

function reconstructListExchange(tc: SessionHistoryMessage["toolCalls"][number]): AskUserExchange {
  const exchange: AskUserExchange = {
    requestId: tc.id,
    questions: [],
    list: listSpecFromInput(tc.input),
  };
  if (tc.output && !tc.isError) {
    try {
      const payload = JSON.parse(tc.output) as {
        answers?: unknown;
        notes?: unknown;
      };
      if (payload && isBareAnswersMap(payload.answers)) {
        exchange.answers = payload.answers;
        if (isBareAnswersMap(payload.notes)) exchange.notes = payload.notes;
      } else {
        exchange.cancelled = true;
      }
    } catch {
      exchange.cancelled = true;
    }
  } else if (tc.isError) {
    exchange.cancelled = true;
  }
  return exchange;
}

export function formSpecFromInput(input: Record<string, unknown> | undefined): AskUserFormSpec {
  const parsed = ASK_USER_FORM_INPUT_SCHEMA.parse(input);
  // A historical request already passed its host configuration. Check structure
  // without imposing this client's defaults on a host's larger valid form.
  return askUserFormSpec(parsed, { maxDepth: parsed.nodes.length, maxNodes: parsed.nodes.length, maxOptions: Math.max(2, ...parsed.nodes.map((node) => node.kind === "single" || node.kind === "multi" ? node.options.length : node.kind === "scale" ? node.scale.length : 0)) });
}
function reconstructFormExchange(tc: SessionHistoryMessage["toolCalls"][number]): AskUserExchange {
  const exchange: AskUserExchange = { requestId: tc.id, questions: [], form: { prompt: "Conditional questions", nodes: [] } };
  try {
    exchange.form = formSpecFromInput(tc.input);
    if (tc.output && !tc.isError) {
      const result = askUserFormPayload(exchange.form, JSON.parse(tc.output));
      exchange.formAnswers = result.answers;
      exchange.visibleNodes = result.visibleNodes;
    } else if (tc.isError) exchange.cancelled = true;
    // No output yet: the question is still open, as for the other three
    // kinds, so the host's re-delivery can bind to this card (#910).
  } catch { exchange.cancelled = true; }
  return exchange;
}

export function rankSpecFromInput(input: Record<string, unknown> | undefined): AskUserRankSpec {
  const list = listSpecFromInput(input);
  const cutoff = typeof input?.cutoff === "number" ? input.cutoff : undefined;
  return { prompt: list.prompt, items: list.items, ...(cutoff !== undefined ? { cutoff } : {}) };
}
function reconstructRankExchange(tc: SessionHistoryMessage["toolCalls"][number]): AskUserExchange {
  const rank = rankSpecFromInput(tc.input);
  const exchange: AskUserExchange = { requestId: tc.id, questions: [], rank };
  if (tc.output && !tc.isError) {
    try {
      const payload = JSON.parse(tc.output);
      const ids = rank.items.map((item) => item.id);
      if (!Array.isArray(payload.order) || payload.order.length !== ids.length || new Set(payload.order).size !== ids.length || payload.order.some((item: unknown) => typeof item !== "string" || !ids.includes(item)) || typeof payload.unchanged !== "boolean") throw new Error("Invalid rank result");
      exchange.order = payload.order;
      exchange.unchanged = ids.every((item, index) => item === payload.order[index]);
    } catch { exchange.cancelled = true; }
  } else if (tc.isError) exchange.cancelled = true;
  return exchange;
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
    // The host resends pending approvals after all history chunks (#1259).
    // Finish that replay before restoring its card, so the later running
    // status cannot replace it with history that has no tool entry yet.
    const closed = context.buffer()?.messages.some((message) => message.toolCalls.some((tool) =>
      tool.id === msg.toolUseId && tool.readOnly && tool.readOnly !== "unlisted"));
    // Keep the store's rejection of answered/ended/revoked cards intact.
    if (!closed) context.state.finishHistoryReplay(context.key, true);
    context.state.requestToolApproval(
      context.key,
      msg.toolUseId,
      msg.toolName,
      msg.input,
      msg.description,
      msg.kind,
      msg.rememberable,
      context.frameTurnId
    );
  },
  tool_result: (msg, context) => {
    context.state.setToolResult(context.key, msg.toolUseId, msg.output, msg.isError);
    // Once the agent receives the ask_user tool result, the exchange is
    // complete — drop any leftover ask_user UI state.
    const chat = context.buffer();
    if (chat?.askUser?.answers || chat?.askUser?.order || chat?.askUser?.formAnswers || chat?.askUser?.cancelled) {
      context.state.clearAskUser(context.key);
    }
  },
  // The request frame's turn is the binding the answer must carry (#910).
  ask_user_request: (msg, context) => {
    context.state.setAskUserRequest(context.key, msg.requestId, msg.questions, context.frameTurnId);
  },
  ask_user_list_request: (msg, context) => {
    const { prompt, scale, items, allowSkip, notes } = msg;
    context.state.setAskUserListRequest(context.key, msg.requestId, {
      prompt,
      scale,
      items,
      allowSkip,
      notes,
    }, context.frameTurnId);
  },
  ask_user_rank_request: (msg, context) => {
    const { prompt, items, cutoff } = msg;
    context.state.setAskUserRankRequest(context.key, msg.requestId, { prompt, items, ...(cutoff !== undefined ? { cutoff } : {}) }, context.frameTurnId);
  },
  ask_user_form_request: (msg, context) => {
    context.state.setAskUserFormRequest(context.key, msg.requestId, formSpecFromInput({ prompt: msg.prompt, nodes: msg.nodes }), context.frameTurnId);
  },
  result: (msg, context) => {
    context.state.finishAssistantMessage(context.key);
    // An absent outcome is the legacy wire, where `isError` alone decides.
    const failed = msg.outcome === "error" || (msg.outcome === undefined && msg.isError);
    if (failed) {
      // The terminal frame's failure is the fullest account, so it replaces
      // whatever a diagnostic `error` frame recorded first; without one, a
      // failure already shown stands.
      context.state.failAssistantMessage(
        context.key,
        msg.failure ?? unreportedFailure(msg.outcomeDetail),
        context.frameTurnId,
        msg.failure !== undefined
      );
    }
    if (failed) context.state.setRetryHandle(context.key, msg.retryOfTurnId);
    context.resyncIfNeeded(msg.sessionId);
  },
  // Receipts are consumed by the connection before transcript demultiplexing.
  retry_receipt: () => {},
  ask_answer_receipt: () => {},
  // The SDK client answers its own probes; a pong never reaches a consumer.
  pong: () => {},
  message_blocks: (msg, context) => {
    // Arrives after `result`, for the turn's own assistant message. An
    // answer never waits on it: the markdown is already on screen, and this
    // only says which spans to draw as blocks (D42). Targeted by the turn
    // the frame belongs to: a queued follow-up may already have opened a
    // newer assistant message by the time the pass returns.
    context.state.setMessageBlocks(context.key, msg.blocks, context.frameTurnId);
  },
  local_exchange_result: (msg, context) => {
    context.state.markLocalExchange(msg.exchangeId, msg.saved ? "saved" : "unsaved", msg.reason);
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
    if (context.key !== null) context.state.noteHistoryLoaded(context.key);
  },
  status: (msg, context) => {
    // Both a resume and the host's connect snapshot send their scoped status
    // after all history chunks. A queued request is not that answer.
    if (context.frameSessionId && msg.status !== "queued") {
      context.state.finishHistoryReplay(context.key, msg.status !== "idle" && msg.status !== "cancelled");
    }
    // A model call the runtime is retrying: the turn is alive, and says why
    // it is waiting (#575). Any other progress means the retry is behind it.
    if (msg.status === "thinking" || msg.status === "tool_executing") {
      context.state.setRetry(context.key, msg.retry ?? null);
    }
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
