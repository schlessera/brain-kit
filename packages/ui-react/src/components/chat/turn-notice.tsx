/**
 * How a turn stopped, when no failure says so (#3356): one concise status
 * row after the turn's content, never in the agent's voice.
 *
 * The cause words only what was observed. `timeout` comes from the host's
 * own report that its hard turn limit ended the turn; `aborted` and
 * `unspecified` come from the notice the agent runtime wrote into the
 * transcript, which does not say who stopped the turn or whether earlier
 * steps took effect. Like the failure card (D51), only a notice that arrived
 * live is announced, politely and once; a replay announces nothing.
 */
import { useEffect, useState } from "react";

import { useBrainUiRoot } from "../../root-context.js";
import type { ChatMessage, TurnNotice as TurnNoticeValue } from "../../stores/chat-store.js";
import { useChatStore } from "../../stores/chat-store.js";

const TURN_NOTICE_COPY: Record<TurnNoticeValue["cause"], { tag: string; body: string }> = {
  timeout: {
    tag: "Turn timed out",
    body: "The host's time limit for one turn ran out, so this turn stopped.",
  },
  aborted: {
    tag: "Turn stopped",
    body: "The agent runtime recorded that this turn's request was aborted.",
  },
  unspecified: {
    tag: "Turn ended without a reply",
    body: "The agent runtime noted that this turn ended without an answer.",
  },
};

export function TurnNotice({ message }: { message: ChatMessage }) {
  const root = useBrainUiRoot();
  const sessionId = useChatStore((s) => s.activeSessionId);
  const notice = message.runtimeNotice!;
  const copy = TURN_NOTICE_COPY[notice.cause];
  // Fixed at mount: a replay that keeps this row mounted does not announce.
  const [announce] = useState(Boolean(message.runtimeNoticeLive));
  useEffect(() => {
    if (!message.runtimeNoticeLive) return;
    const chat = root.stores.chat.getState();
    const buffer = sessionId ? chat.buffers[sessionId] : chat.draft;
    if (!buffer) return;
    const messages = buffer.messages.map((m) => (m.id === message.id ? { ...m, runtimeNoticeLive: false } : m));
    if (sessionId) root.stores.chat.setState({ buffers: { ...chat.buffers, [sessionId]: { ...buffer, messages } } });
    else root.stores.chat.setState({ draft: { ...buffer, messages } });
  }, [root, sessionId, message.id, message.runtimeNoticeLive]);

  return (
    <div
      className="mt-2 space-y-0.5 border-t border-border/40 pt-2"
      data-turn-notice={notice.cause}
    >
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        {copy.tag}
      </p>
      <p className="text-sm text-foreground/90 break-words">{copy.body}</p>
      <p className="sr-only" role="status" aria-live="polite">
        {announce ? `${copy.tag}. ${copy.body}` : ""}
      </p>
    </div>
  );
}
