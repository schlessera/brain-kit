import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BottomSheet, Button, TurnErrorCard } from "@schlessera/brain-ui-kit";
import { PROTOCOL_REV, SUBSCRIPTION_AUTH_INSTRUCTIONS, type TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import type { ChatMessage } from "../../stores/chat-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { failurePresentation, redactProviderMessage } from "../../lib/turn-failure.js";

type Review = { mode: "copy" | "report"; initial: string };

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
    ...(latest && presentation.retry && message.retryOfTurnId ? [{ label: uncertain ? "Check delivery" : busy ? "Retrying…" : "Retry", primary: true, disabled: busy, onClick: () => {
      if (uncertain && sessionId) { root.connection.checkRetryDelivery(sessionId); return; }
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
        operator={presentation.operator} announce={announce} actions={actions} busy={busy} notice={uncertain ? "Delivery is unconfirmed. Check delivery before sending another turn." : pending?.state === "refused" ? pending.message : notice}
        retryWarning={latest && presentation.retry && Boolean(message.retryOfTurnId)} />
      {review ? <DiagnosticReview review={review} failure={failure} onClose={() => setReview(null)} /> : null}
    </div>
  );
}

/** All outward bytes come from the editable field after the reader reviews them. */
function DiagnosticReview({ review, failure, onClose }: { review: Review; failure: TurnFailure; onClose: () => void }) {
  const [text, setText] = useState(review.initial);
  const [included, setIncluded] = useState(false);
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fieldId = useId();
  const title = review.mode === "report" ? "What will be sent" : "What will be copied";
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = dialog.current!;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
    heading.current?.focus();
    return () => { node.close?.(); if (opener?.isConnected) opener.focus(); };
  }, []);

  async function copy() {
    try { await navigator.clipboard.writeText(text); setNotice("Copied reviewed details."); }
    catch { setNotice("Couldn't copy. Select the reviewed text and copy it manually."); }
  }
  function report() {
    const url = new URL("https://github.com/schlessera/brain-kit/issues/new");
    url.searchParams.set("title", "Chat turn failure");
    url.searchParams.set("body", text);
    // No implicit truncation: the exact field is the payload. Large reports
    // can be copied and pasted instead of silently editing the reviewed text.
    if (url.href.length > 8000) { setNotice("This report is too long for the issue URL. Copy it and paste it into GitHub."); return; }
    try { window.open(url.href, "_blank", "noopener,noreferrer"); setNotice("If the issue form did not open, copy the reviewed text and paste it into GitHub."); }
    catch { setNotice("Couldn't open the issue form. Copy the reviewed text and paste it into GitHub."); }
  }
  function includeProvider() {
    if (included) return;
    const redacted = redactProviderMessage(failure.message);
    const shown = redacted.slice(0, 1500);
    setText(current => `${current}\n\nProvider message (review before sharing):\n${shown}${redacted.length > shown.length ? `\n[${redacted.length - shown.length} characters not included]` : ""}`);
    setIncluded(true);
  }
  return createPortal(
    <dialog ref={dialog} aria-label={title} className="turn-diagnostic-dialog" onCancel={e => { e.preventDefault(); onClose(); }}
      onKeyDown={e => {
        if (e.key !== "Tab") return;
        const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')]
          .filter(node => node.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (!first || !last) { e.preventDefault(); heading.current?.focus(); return; }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }}>
      <h2 ref={heading} tabIndex={-1} className="bk-sr-only">{title}</h2>
      <BottomSheet title={title} icon="scope" subtitle={review.mode === "report"
        ? "Opening the issue sends this text to GitHub before you submit the issue. Review and edit it first."
        : "Review and edit this text. Copy places it on your clipboard only when you choose Copy."}>
        <label className="block text-xs text-muted-foreground" htmlFor={fieldId}>Exact outgoing text</label>
        <textarea id={fieldId} value={text} onChange={e => setText(e.target.value)}
          className="mt-2 w-full min-h-48 rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs text-foreground" />
        <p className="my-3 text-xs text-muted-foreground">Provider text is omitted by default. Optional redaction is best effort; review for private content and credentials.</p>
        <div className="flex flex-col gap-2">
          <Button label="Include provider message for review" disabled={included} tone="ghost" onClick={includeProvider} style={{ minHeight: 44 }} />
          {review.mode === "report" ? <Button label="Open issue on GitHub" effect="opens browser" onClick={report} style={{ minHeight: 44 }} /> : null}
          <Button label="Copy" onClick={() => void copy()} style={{ minHeight: 44 }} />
          <Button label="Close review" tone="ghost" onClick={onClose} style={{ minHeight: 44 }} />
        </div>
        {notice ? <p role="status" className="mt-3 text-xs text-muted-foreground">{notice}</p> : null}
      </BottomSheet>
    </dialog>, document.body,
  );
}
