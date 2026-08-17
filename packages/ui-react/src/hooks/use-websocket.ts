import { useEffect, useRef, useCallback } from "react";
import { WSClient } from "../lib/ws-client.js";
import { useConnectionStore } from "../stores/connection-store.js";
import { useChatStore, activeChat, type ChatKey } from "../stores/chat-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useMaskStore } from "../stores/mask-store.js";
import { getWsUrl } from "../lib/backend.js";
import type {
  ServerMessage,
  ClientMessage,
  ServerLocationRequest,
  SessionHistoryMessage,
  AskUserQuestion,
} from "@schlessera/brain-ui-sdk/protocol";
import type { ChatMessage, ToolCall, AskUserExchange } from "../stores/chat-store.js";
import { isAskUserTool } from "../lib/tool-names.js";

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
  };
}

/**
 * Rebuild ask_user exchanges from a resumed message's tool calls. The ask_user
 * tool's input carries the questions and its output carries the JSON answer
 * payload, so an answered question survives session resume (rendered in its
 * chronological slot, collapsed) instead of vanishing.
 */
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
        exchange.answers = payload.answers;
        exchange.annotations = payload.annotations;
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

export function handleServerMessage(msg: ServerMessage) {
  const state = useChatStore.getState();

  // Parallel-session demux (per-session buffers). Every frame is scoped by
  // sessionId; a scoped frame lands in ITS session's buffer, so a background
  // session's transcript keeps accumulating while another one is in view.
  // Frames without a sessionId (legacy single-session servers, or a new
  // session's pre-binding frames) apply to the buffer in view.
  const frameSessionId = (msg as { sessionId?: string }).sessionId;
  if (frameSessionId) {
    state.setRunState(frameSessionId, runStateForFrame(msg));
  }

  // Resolve the target buffer key for this frame.
  let key: ChatKey;
  if (!frameSessionId) {
    key = state.activeSessionId; // null = the draft view
  } else if (state.buffers[frameSessionId]) {
    key = frameSessionId;
  } else if (state.draft && (msg.type === "session_info" || msg.type === "result")) {
    // A draft run just got its server identity: adopt the draft buffer.
    state.bindDraftSession(frameSessionId);
    key = frameSessionId;
  } else if (msg.type === "session_info" && frameSessionId === state.activeSessionId) {
    // The ACTIVE session announced itself but has no buffer yet — the cold
    // reattach case (PWA relaunch mid-turn; the server may skip the history
    // frame when a first turn has no history yet). Materialize the buffer so
    // this session_info and every following delta land instead of vanishing.
    state.setActiveSession(frameSessionId);
    key = frameSessionId;
  } else if (msg.type === "session_history") {
    // History replay may create a buffer (cold resume / reattach).
    key = frameSessionId;
  } else {
    // Scoped frame for a session with no buffer (never opened, or evicted):
    // the badge above is all we track. The transcript heals via
    // session_resume when the user opens it.
    return;
  }

  const buffer = () => {
    const s = useChatStore.getState();
    return key === null ? s.draft : s.buffers[key];
  };

  switch (msg.type) {
    case "text_delta":
      if (!buffer()?.isStreaming) {
        state.startAssistantMessage(key);
      }
      state.appendText(key, msg.text);
      break;

    case "thinking_delta":
      if (!buffer()?.isStreaming) {
        state.startAssistantMessage(key);
      }
      state.appendThinking(key, msg.text);
      break;

    case "tool_use_start":
      state.startToolCall(key, msg.toolUseId, msg.toolName);
      break;

    case "tool_input_delta":
      state.appendToolInput(key, msg.partialJson);
      break;

    case "tool_use_complete":
      state.completeToolCall(key, msg.toolUseId, msg.toolName, msg.input);
      break;

    case "tool_approval_request":
      state.requestToolApproval(key, msg.toolUseId, msg.toolName, msg.input, msg.description);
      break;

    case "tool_result": {
      state.setToolResult(key, msg.toolUseId, msg.output, msg.isError);
      // Once the agent receives the ask_user tool result, the exchange is
      // complete — drop any leftover ask_user UI state.
      const chat = buffer();
      if (chat?.askUser?.answers || chat?.askUser?.cancelled) {
        state.clearAskUser(key);
      }
      break;
    }

    case "ask_user_request":
      state.setAskUserRequest(key, msg.requestId, msg.questions);
      break;

    case "location_request":
      requestBrowserLocation(msg);
      break;

    case "mask_request":
      // Opens the editor; the answer travels back from the component, because
      // only the user can say which part of the picture they meant.
      useMaskStore.getState().open({
        requestId: msg.requestId,
        imagePath: msg.imagePath,
        ...(msg.instruction ? { instruction: msg.instruction } : {}),
        ...(msg.turnId ? { turnId: msg.turnId } : {}),
      });
      break;

    case "result":
      state.finishAssistantMessage(key);
      resyncIfNeeded(msg.sessionId);
      break;

    case "session_info": {
      // bindDraftSession above handled draft adoption; an info frame may still
      // re-pin the provider picker when it concerns the session in view.
      const current = useChatStore.getState();
      if (frameSessionId && frameSessionId === current.activeSessionId) {
        useProviderStore.getState().setPinned(msg.providerId ?? null);
        // Reattachment on a fresh connection: enter streaming mode so deltas
        // append to a live assistant message instead of vanishing.
        const chat = current.buffers[frameSessionId];
        if (chat && !chat.isStreaming && chat.messages.length === 0) {
          current.startAssistantMessage(frameSessionId);
        }
      }
      break;
    }

    case "session_history": {
      const converted = msg.messages.map(convertHistoryMessage);
      if (msg.append) {
        state.appendMessages(key, converted);
      } else {
        // First (replacing) chunk = fresh authoritative transcript. Cancel any
        // pending reconnect resync so we don't redundantly re-fetch it, and
        // mark this session cold-resumed so idle-status handling doesn't loop.
        state.setMessages(key, converted);
        if (key !== null && key === resyncSessionId) resyncSessionId = null;
        coldResumedSessionId = key;
      }
      break;
    }

    case "status": {
      // Only finish streaming if this buffer actually started it
      if (
        (msg.status === "idle" || msg.status === "cancelled") &&
        buffer()?.isStreaming
      ) {
        state.finishAssistantMessage(key);
      }
      // A session that finished while we were offline never delivers its
      // `result` — the idle status on reconnect is the cue to resync. Keyed to
      // THIS frame's session: a background session settling must not consume
      // (or trigger) the active session's pending resync.
      if (msg.status === "idle" || msg.status === "cancelled") {
        const current = useChatStore.getState();
        resyncIfNeeded(frameSessionId ?? current.activeSessionId);
        // Cold load: we hold a stored session id but an empty transcript and
        // the server is idle (so it sent no snapshot). Fetch the history.
        // Only the active session's own (or an unscoped legacy) idle counts.
        if (!frameSessionId || frameSessionId === current.activeSessionId) {
          coldResumeIfNeeded(current.activeSessionId, activeChat(current).messages.length);
        }
      }
      break;
    }

    case "error":
      if (buffer()?.isStreaming) {
        state.appendText(key, `\n\n**Error:** ${msg.message}`);
        state.finishAssistantMessage(key);
      }
      break;
  }
}

/**
 * The server asked the browser for its location (the agent called
 * `get_current_location`). Read `navigator.geolocation` and reply over the same
 * requestId. The browser shows its own permission prompt on first use; a denial,
 * timeout, or unavailable position comes back as a `location_error` that the
 * server turns into a tool error for the agent.
 */
function requestBrowserLocation(msg: ServerLocationRequest) {
  const { requestId } = msg;
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    wsClient?.send({
      type: "location_error",
      requestId,
      code: 0,
      message: "Geolocation is not available in this browser.",
    });
    return;
  }
  const opts = msg.options ?? {};
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      wsClient?.send({
        type: "location_response",
        requestId,
        coords: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        },
        timestamp: pos.timestamp,
      });
    },
    (err) => {
      wsClient?.send({
        type: "location_error",
        requestId,
        code: err.code,
        message: err.message || "Failed to retrieve location.",
      });
    },
    {
      enableHighAccuracy: opts.enableHighAccuracy ?? false,
      timeout: opts.timeoutMs ?? 15000,
      maximumAge: opts.maximumAgeMs ?? 60000,
    }
  );
}

// Reconnection bookkeeping: after a WS drop, the rendered transcript may have
// gaps (deltas streamed while offline are lost). We heal by replaying the
// authoritative session history — immediately if nothing is streaming, or
// once the in-flight turn settles (result / idle status). The pending resync
// is keyed to the session that needs healing (the one that was active at the
// reconnect), so a background session settling first cannot consume it.
let wasDisconnected = false;
let resyncSessionId: string | null = null;

function resyncIfNeeded(sessionId: string | null) {
  if (!resyncSessionId || !sessionId || sessionId !== resyncSessionId) return;
  resyncSessionId = null;
  wsClient?.send({ type: "session_resume", sessionId });
}

// A cold page / PWA relaunch restores only the stored session id, not the
// transcript. The server pushes a snapshot on connect only while a session is
// actively running; when it's idle (the common "agent finished while the phone
// slept" case) nothing arrives, so the client must fetch the finished
// session's history itself. Guarded to fire at most once per session id per
// connection — an empty session would otherwise re-trigger on every idle
// status and loop.
let coldResumedSessionId: string | null = null;

function coldResumeIfNeeded(sessionId: string | null, messageCount: number) {
  if (!sessionId || messageCount > 0) return;
  if (coldResumedSessionId === sessionId) return;
  coldResumedSessionId = sessionId;
  wsClient?.send({ type: "session_resume", sessionId });
}

function handleStatusChange(status: "connecting" | "connected" | "disconnected") {
  useConnectionStore.getState().setWsStatus(status);

  if (status === "disconnected") {
    wasDisconnected = true;
    // Allow a fresh cold-resume attempt after we reconnect.
    coldResumedSessionId = null;
  } else if (status === "connected" && wasDisconnected) {
    wasDisconnected = false;
    const chat = useChatStore.getState();
    const active = activeChat(chat);
    if (chat.activeSessionId && active.messages.length > 0) {
      resyncSessionId = chat.activeSessionId;
      // Not mid-stream: replay right away. Mid-stream: the flag holds until
      // the running turn finishes (result or idle status).
      if (!active.isStreaming) {
        resyncIfNeeded(chat.activeSessionId);
      }
    }
  }
}

// Singleton client - survives React re-renders
let wsClient: WSClient | null = null;

export function useWebSocket() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    wsClient = new WSClient(getWsUrl(), handleServerMessage, handleStatusChange);
    wsClient.connect();

    // Skip the exponential backoff when the network demonstrably returns.
    const reconnectNow = () => wsClient?.reconnectNow();
    const onVisible = () => {
      if (document.visibilityState === "visible") wsClient?.reconnectNow();
    };
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
      wsClient?.close();
      wsClient = null;
      initialized.current = false;
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    wsClient?.send(msg);
  }, []);

  return { send };
}
