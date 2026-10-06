/**
 * The footer every ask card carries once an answer has been submitted
 * (#910): where that answer stands, in the approved design's words, with
 * the actions that state allows.
 *
 * Focus (design §6): after Submit, focus moves to the status tag, a heading
 * with `tabIndex=-1`, so a keyboard or screen-reader user is left on the
 * outcome rather than on a control that has just disappeared. The polite live
 * region beside it carries the state's words when the state is one the
 * design announces; it changes only when the state does, so each is
 * announced once.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@schlessera/brain-ui-kit";

import { useBrainUiRoot } from "../../root-context.js";
import { deliveryCopy, SEND_AS_MESSAGE_NOTE, type DeliveryAction } from "../../lib/answer-delivery/copy.js";
import type { AnswerDelivery } from "../../lib/answer-delivery/types.js";

const LABELS: Record<DeliveryAction, string> = {
  cancel: "Cancel sending",
  copy: "Copy answer",
  sendAsMessage: "Send as message",
  edit: "Edit",
  reload: "Reload app",
  tryAgain: "Try again",
};

export function AnswerDeliveryStatus({
  delivery,
  answerText,
  onSendAsMessage,
}: {
  delivery: AnswerDelivery;
  /** The submitted answer as plain text, for Copy and Send as message. */
  answerText: () => string;
  /** Sends `text` as a new ordinary chat message. */
  onSendAsMessage?: (text: string) => void;
}) {
  const root = useBrainUiRoot();
  const tagRef = useRef<HTMLHeadingElement>(null);
  const copy = deliveryCopy(delivery);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!delivery.focus || delivery.mirror) return;
    tagRef.current?.focus();
    const chat = root.stores.chat.getState();
    const current = chat.deliveries[delivery.requestId];
    if (current?.focus) chat.setDelivery(delivery.requestId, { ...current, focus: false });
  }, [delivery.focus, delivery.mirror, delivery.requestId, root]);

  const queue = root.answers;
  const run = (action: DeliveryAction) => {
    switch (action) {
      case "cancel":
        void queue.cancel(delivery.requestId);
        return;
      case "edit":
        queue.edit(delivery.requestId);
        return;
      case "tryAgain":
        void queue.retry(delivery.requestId);
        return;
      case "reload":
        window.location.reload();
        return;
      case "copy":
        void navigator.clipboard?.writeText(answerText()).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => {}
        );
        return;
      case "sendAsMessage":
        onSendAsMessage?.(answerText());
        return;
    }
  };
  // A mirror shows the owner's state; only the owning tab acts on it.
  const actions = delivery.mirror
    ? []
    : copy.actions.filter((a) => a !== "sendAsMessage" || onSendAsMessage);

  return (
    <div
      className="mt-2 space-y-1.5 border-t border-border/40 pt-2"
      data-answer-delivery={delivery.state}
      data-submission={delivery.submissionId || undefined}
    >
      <h4
        ref={tagRef}
        tabIndex={-1}
        className="font-mono text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {copy.tag}
      </h4>
      <p className="sr-only" aria-live="polite" role="status">
        {copy.announce ? [copy.tag, copy.body].filter(Boolean).join(". ") : ""}
      </p>
      {copy.body ? <p className="text-sm text-foreground/90">{copy.body}</p> : null}
      {actions.length > 0 || copy.meta ? (
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              label={action === "copy" && copied ? "Copied" : LABELS[action]}
              tone={action === "reload" || action === "tryAgain" ? undefined : "ghost"}
              size="sm"
              block={false}
              onClick={() => run(action)}
              style={{ minHeight: 44 }}
            />
          ))}
          {copy.meta ? (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">{copy.meta}</span>
          ) : null}
        </div>
      ) : null}
      {actions.includes("sendAsMessage") ? (
        <p className="text-xs text-muted-foreground">{SEND_AS_MESSAGE_NOTE}</p>
      ) : null}
    </div>
  );
}
