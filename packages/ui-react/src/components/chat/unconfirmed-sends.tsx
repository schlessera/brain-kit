import { useMemo } from "react";
import { Button } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import type { DraftSend } from "../../stores/draft-state.js";

/**
 * A send the host never confirmed, held for review where it was sent (D52
 * §5, #951). It is the immutable snapshot the composer submitted, never the
 * editable draft, and nothing resends it on its own:
 *
 * - **Check again** reads the session's recovery envelope: accepted makes it
 *   a normal turn, not accepted keeps the block, and can't check changes
 *   nothing but says why.
 * - **Send again** sends the same snapshot under a new request id.
 * - **Edit** puts its text and images back into this view's draft, and the
 *   block closes.
 *
 * Leaving the session gives it an `unconfirmed` tracker (D52 §4).
 */
export function UnconfirmedSends() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const sends = useRootStore("drafts", (s) => s.sends);
  const held = useMemo(() => Object.values(sends)
    // Every new chat's unconfirmed first message is held in the new-chat
    // view, whichever new chat is open: it has no session to be found in.
    .filter((s) => s.state === "unconfirmed" && s.sessionId === sessionId)
    .sort((a, b) => a.sentAt - b.sentAt), [sends, sessionId]);
  if (held.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 py-3" data-unconfirmed-sends="">
      {held.map((send) => <UnconfirmedSend key={send.requestId} send={send} />)}
    </div>
  );
}

function UnconfirmedSend({ send }: { send: DraftSend }) {
  const root = useBrainUiRoot();
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const why = send.reason === "uncorrelated"
    ? "The host refused a message without saying which, so it may not have got this."
    : "The connection dropped before the host confirmed it got this.";
  const checked = send.checked === "cant_check"
      ? `Can't check · ${send.checkReason ?? "host unreachable"}`
      : send.checked === "checking" ? "Checking…" : null;
  const images = send.attachments.length;
  return (
    <section
      aria-label="Message not confirmed"
      className="rounded-2xl border border-border bg-surface p-4"
      data-unconfirmed-send={send.requestId}
    >
      <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-primary">Didn&apos;t hear back</div>
      {send.text ? <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-6 text-foreground">{send.text}</p> : null}
      {images > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {send.attachments.map((a, i) => <img key={i} src={a.previewUrl} alt={a.name} className="h-12 w-12 rounded-lg border border-border object-cover" />)}
        </div>
      ) : null}
      <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{why}</p>
      <p className="mt-1 min-h-0 font-mono text-[10.5px] text-muted-foreground" role="status">{checked}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button label="Check again" tone="primary" size="md" block={false} ariaDisabled={send.checked === "checking"}
          onClick={() => { if (send.checked !== "checking") void root.connection.drafts.check(send.requestId); }} />
        <Button label="Send again" tone="ghost" size="md" block={false} ariaDisabled={!connected}
          {...(!connected ? { subtitle: "needs the host" } : {})}
          onClick={() => { if (connected) root.connection.drafts.resend(send.requestId); }} />
        <Button label="Edit" tone="ghost" size="md" block={false}
          onClick={() => {
            root.stores.drafts.getState().editSend(send.requestId);
            // The text is back in the field: put the caret there.
            setTimeout(() => {
              const field = document.querySelector<HTMLTextAreaElement>("[data-composer] textarea");
              if (!field) return;
              field.focus();
              field.setSelectionRange(field.value.length, field.value.length);
            }, 0);
          }} />
      </div>
    </section>
  );
}
