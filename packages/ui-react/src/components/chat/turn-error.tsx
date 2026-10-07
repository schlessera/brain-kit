import { useEffect, useState } from "react";
import { TurnErrorCard } from "@schlessera/brain-ui-kit";
import { PROTOCOL_REV, SUBSCRIPTION_AUTH_INSTRUCTIONS } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import type { ChatMessage } from "../../stores/chat-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { failurePresentation, redactProviderMessage, providerMessageInclusion } from "../../lib/turn-failure.js";
import { DiagnosticReview } from "../report/diagnostic-review.js";

type Review = { mode: "copy" | "report"; initial: string };

/** Count down to the reported absolute reset; replay never starts a new delay. */
function useResetCountdown(resetsAt: number | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (resetsAt === undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const remaining = resetsAt - current;
      if (remaining > 0) timer = setTimeout(tick, Math.min(1000, remaining));
    };
    tick();
    return () => clearTimeout(timer);
  }, [resetsAt]);
  return resetsAt === undefined ? 0 : Math.max(0, Math.ceil((resetsAt - now) / 1000));
}

export function TurnError({ message, latest }: { message: ChatMessage; latest: boolean }) {
  const root = useBrainUiRoot();
  const failure = message.failure!;
  const sessionId = useChatStore(s => s.activeSessionId);
  const pending = useChatStore(s => sessionId ? s.turnRetries[sessionId] : undefined);
  const backend = useChatStore(s => sessionId ? s.backendIds[sessionId] : undefined);
  const repeated = useChatStore(s => sessionId ? (s.buffers[sessionId]?.messages.filter(m => m.failure?.errorClass === failure.errorClass).length ?? 0) > 1 : false);
  const busy = Boolean(pending) && pending?.failedTurnId === message.retryOfTurnId && pending?.state === "waiting";
  const uncertain = Boolean(pending) && pending?.failedTurnId === message.retryOfTurnId && pending?.state === "unknown";
  const presentation = failurePresentation(failure);
  const resetSeconds = useResetCountdown(latest && presentation.retry && message.retryOfTurnId ? failure.resetsAt : undefined);
  // A failure the host replayed (it carries no `failureLive`) is not the
  // newly received one, also when a replay keeps this card mounted (#1013).
  const [announce] = useState(message.failureLive);
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!message.failureLive) return;
    const chat = root.stores.chat.getState();
    const buffer = sessionId ? chat.buffers[sessionId] : chat.draft;
    if (!buffer) return;
    const messages = buffer.messages.map(m => m.id === message.id ? { ...m, failureLive: false } : m);
    if (sessionId) root.stores.chat.setState({ buffers: { ...chat.buffers, [sessionId]: { ...buffer, messages } } });
    else root.stores.chat.setState({ draft: { ...buffer, messages } });
  }, [root, sessionId, message.id, message.failureLive]);
  const rows = [
    ...(backend ? [{ k: "backend", v: backend }] : []),
    ...(failure.status !== undefined ? [{ k: "status", v: String(failure.status) }] : []),
    ...(failure.attempts !== undefined ? [{ k: "retries", v: String(failure.attempts) }] : []),
    { k: "class", v: failure.errorClass },
  ];
  function openReview(mode: Review["mode"]) {
    const knownClass = /^(authentication_failed|oauth_org_not_allowed|account_on_hold|billing_error|subscription_required|rate_limit|overloaded|server_error|invalid_request|model_not_found|max_output_tokens|unknown)$/.test(failure.errorClass)
      ? failure.errorClass : "unknown";
    const fields = ["brain-kit failed turn", `protocol: ${PROTOCOL_REV}`, `class: ${knownClass}`,
      ...(["claude", "pi"].includes(backend ?? "") ? [`backend: ${backend}`] : []),
      ...(failure.status !== undefined ? [`HTTP status: ${failure.status}`] : []),
      ...(failure.authAction ? ["", SUBSCRIPTION_AUTH_INSTRUCTIONS[failure.authAction]] : [])];
    setReview({ mode, initial: fields.join("\n") });
  }
  const actions = [
    // Retry is wired below to the host's retained original request, rather
    // than reconstructing an attachment-bearing prompt from count-only history.
    ...(latest && presentation.retry && message.retryOfTurnId ? [{ label: uncertain ? "Check delivery" : busy ? "Retrying…" : resetSeconds > 0 ? `Retry · in ${resetSeconds}s` : "Retry", primary: true, disabled: busy || (!uncertain && resetSeconds > 0), onClick: () => {
      if (uncertain && sessionId) { root.connection.checkRetryDelivery(sessionId); return; }
      if (failure.resetsAt !== undefined && failure.resetsAt > Date.now()) return;
      const result = root.connection.retryTurn(message.retryOfTurnId!);
      if (result === "refused") setNotice("Couldn't send. Check the connection and try again.");
    }}] : []),
    { label: failure.authAction ? "Copy instructions" : "Copy details", primary: !presentation.retry || !latest || !message.retryOfTurnId, disabled: busy,
      onClick: () => openReview("copy") },
    ...(presentation.report || (failure.errorClass === "server_error" && repeated) ? [{ label: "Report a bug", disabled: busy, onClick: () => openReview("report") }] : []),
  ];
  return (
    <div data-turn-failure={failure.errorClass}>
      <TurnErrorCard headline={presentation.headline} explanation={presentation.explanation} tone={presentation.tone}
        rows={rows} backend={backend} providerMessage={redactProviderMessage(failure.message)} providerOpen={failure.errorClass === "unknown"}
        operator={presentation.operator} announce={announce && Boolean(message.failureLive)} actions={actions} busy={busy} notice={uncertain ? "Delivery is unconfirmed. Check delivery before sending another turn." : pending?.state === "refused" ? pending.message : notice}
        retryWarning={latest && presentation.retry && Boolean(message.retryOfTurnId)} />
      {review ? (
        <DiagnosticReview mode={review.mode} initialBody={review.initial} defaultIssueTitle="Chat turn failure"
          inclusions={[{ id: "provider", label: "Include provider message for review", build: () => providerMessageInclusion("Provider message", failure.message) }]}
          onClose={() => setReview(null)} />
      ) : null}
    </div>
  );
}
