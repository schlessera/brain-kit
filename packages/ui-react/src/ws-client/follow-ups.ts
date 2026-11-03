import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { StartedFollowUp } from "../stores/follow-up-state.js";
import type { BrainUiServices } from "../root.js";
import type { DraftClient } from "../lib/draft-client.js";
import type { ReconnectHealing } from "./reconnect.js";

type SessionQueue = Extract<ServerMessage, { type: "session_queue" }>;

/** Pending follow-ups (#1002): where a queued message enters the transcript. */
export function createFollowUpPlacement(
  root: Pick<BrainUiServices, "stores">,
  deps: { drafts: () => Pick<DraftClient, "queued">; healing: Pick<ReconnectHealing, "refreshAfterTurn" | "refreshFollowUpHistory"> },
) {
  /**
   * A follow-up the agent has just received enters the transcript once, as
   * the user message of its turn, where it entered the conversation (#1002).
   * A session this client holds no buffer for heals from history when opened;
   * a message already drawn (by a history replay) is not drawn again.
   */
  function place(started: StartedFollowUp): void {
    const chat = root.stores.chat.getState();
    const buffer = chat.buffers[started.sessionId];
    if (!buffer) return;
    if (started.requestId && buffer.messages.some((message) => message.role === "user" && message.requestId === started.requestId)) return;
    if (buffer.isStreaming) chat.finishAssistantMessage(started.sessionId);
    chat.addUserMessage(
      started.sessionId,
      started.text,
      started.source,
      started.attachments,
      started.requestId ? { requestId: started.requestId, ...(started.thinkingLevel !== undefined ? { thinkingLevel: started.thinkingLevel } : {}) } : undefined,
      started.files
    );
    if (!started.attachments?.length && started.attachmentCount) {
      const current = root.stores.chat.getState().buffers[started.sessionId]!;
      const messages = [...current.messages];
      messages[messages.length - 1] = { ...messages.at(-1)!, attachmentCount: started.attachmentCount };
      root.stores.chat.setState({ buffers: { ...root.stores.chat.getState().buffers, [started.sessionId]: { ...current, messages } } });
    }
    chat.startAssistantMessage(started.sessionId, started.turnId, started.requestId);
    // Another client's message: the report counts its files but cannot carry
    // what they are, and may carry only the head of a long text. History has
    // both, so this session's is read again once this turn ends.
    if ((started.fileCount && !started.files?.length) || started.textTruncated) deps.healing.refreshAfterTurn(started.sessionId);
  }

  /**
   * A message this client drew in the chat as an ordinary send, but that the
   * host queued instead (#1002): it went out between a turn's `result` and
   * the host handing over its next queued turn, while the transcript had
   * stopped streaming. The host's report is the proof it is waiting, so it
   * leaves the transcript, with the empty reply opened for it, and becomes a
   * pending follow-up that enters the chat when its turn starts.
   */
  function adoptQueued(report: SessionQueue): void {
    const chat = root.stores.chat.getState();
    const buffer = chat.buffers[report.sessionId];
    const queued = new Set(report.followUps.map((entry) => entry.requestId).filter((id): id is string => Boolean(id)));
    if (!buffer || queued.size === 0) return;
    const drawn = buffer.messages.filter((m) => m.role === "user" && m.requestId && queued.has(m.requestId));
    if (drawn.length === 0) return;
    const opened = (m: (typeof buffer.messages)[number]) =>
      m.role === "assistant" && !m.turnId && !m.content && !m.thinking && m.toolCalls.length === 0 && Boolean(m.requestId && queued.has(m.requestId));
    const messages = buffer.messages.filter((m) => !drawn.includes(m) && !opened(m));
    root.stores.chat.setState({
      buffers: {
        ...chat.buffers,
        [report.sessionId]: { ...buffer, messages, isStreaming: buffer.isStreaming && messages.some((m) => m.role === "assistant" && m.isStreaming) },
      },
    });
    for (const m of drawn) {
      root.stores.followUp.getState().addLocal(report.sessionId, {
        requestId: m.requestId!,
        text: m.content,
        source: m.source ?? "typed",
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
        ...(m.files?.length ? { files: m.files } : {}),
        ...(m.thinkingLevel !== undefined ? { thinkingLevel: m.thinkingLevel } : {}),
        queuedAt: m.timestamp,
      });
    }
  }

  /** The host's report of a session's queue: the `session_queue` frame's whole effect. */
  function queueReport(msg: SessionQueue): void {
    // Requests the host holds were accepted, a held send among them (#951).
    deps.drafts().queued(msg);
    adoptQueued(msg);
    const started = root.stores.followUp.getState().applyReport(msg);
    if (started) place(started);
    // The queue emptied with no turn running, as when its last entry is
    // dropped: a history refresh deferred until now has no turn end to wait for.
    else if (msg.followUps.length === 0 && !root.stores.chat.getState().buffers[msg.sessionId]?.isStreaming) deps.healing.refreshFollowUpHistory(msg.sessionId);
  }

  return { place, adoptQueued, queueReport };
}

export type FollowUpPlacement = ReturnType<typeof createFollowUpPlacement>;
