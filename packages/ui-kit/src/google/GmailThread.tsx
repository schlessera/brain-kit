import { useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../primitives/Icon.js";
import { Surface } from "../primitives/Surface.js";
import { color, font } from "../tokens.js";
import { GmailLabels } from "./GmailLabels.js";
import { MessageBody, Recipients, SenderAddress, senderLabel, type GmailContentMessage, type GmailStructuredMessage } from "./GmailMessage.js";
import { StructuredRow } from "./GmailResultList.js";
import { CONTENT_LINE, Field, Flags, META, PROVENANCE, STRUCTURED_LINE, UnreadDot, When, accessibleName, mergeLabels, plural } from "./shared.js";

/**
 * `GmailThread` — the messages of one Gmail thread, oldest first and newest
 * last, as `GitHubThread` orders its items (#4209; design brief §3).
 *
 * - The newest message is open. Each earlier one is a one-line row (sender,
 *   date, a line of its snippet) that opens in place; its toggle stays where
 *   it was, so focus does not move.
 * - With four or more earlier messages, all but the last two fold into one
 *   "Show n earlier messages" row. Opening it moves focus to the first
 *   message it revealed.
 * - The head is the thread's subject, its message count, every label its
 *   messages carry (G5) and whether any is starred.
 *
 * In the structured view the thread is its messages' dates, labels and
 * counts under the one G1 line, as a structured search result is.
 */
export type GmailThreadProps =
  | { view: "content"; messages: readonly GmailContentMessage[] }
  | { view: "structured"; messages: readonly GmailStructuredMessage[] };

/** Earlier messages shown before the rest fold, once there are four or more. */
const KEEP_EARLIER = 2;
const FOLD_FROM = 4;

const H3 = { margin: 0, font: `650 13.5px/1.35 ${font.body}`, color: color.ink } as const;

function MessageItem({ message, initiallyOpen, toggleRef }: { message: GmailContentMessage; initiallyOpen: boolean; toggleRef?: (el: HTMLButtonElement | null) => void }) {
  const [open, setOpen] = useState(initiallyOpen);
  const panel = useId();
  const u = message.untrusted;
  const name = senderLabel(u.from);
  const label = `${message.unread ? "Unread, " : ""}${name ? accessibleName(name) : "Sender not given"}${message.date ? `, ${message.date.full}` : ""}`;
  return (
    <li style={{ borderTop: `1px solid ${color.line}` }} data-gmail-thread-message={open ? "open" : "closed"}>
      <button ref={toggleRef} type="button" className="bk-row bk-gm-crow" aria-expanded={open} aria-controls={panel} aria-label={label} onClick={() => setOpen(!open)}>
        <UnreadDot unread={message.unread} />
        <span className="bk-gm-crow-main">
          <span className="bk-gm-line">
            <span className="bk-gm-grow" style={{ font: `${message.unread ? 650 : 600} 12.5px/1.4 ${font.body}`, color: color.ink }}>
              {name ? <Field text={name} /> : <span style={{ fontStyle: "italic", fontWeight: 400, color: color.inkMute }}>— sender not given</span>}
            </span>
            {message.date ? <When date={message.date} style={{ ...META, color: message.unread ? color.ink : color.inkMute }} /> : null}
          </span>
          {!open && u.snippet ? (
            <span className="bk-gm-clamp-1" style={{ font: `400 12px/1.5 ${font.body}`, color: color.inkDim }}>
              <Field text={u.snippet} />
            </span>
          ) : null}
        </span>
        <span aria-hidden="true" className="bk-gm-crow-chevron">
          <Icon icon={open ? "collapse" : "next"} size={14} />
        </span>
      </button>
      <div id={panel} hidden={!open} style={{ padding: "0 14px 14px 30px", minWidth: 0 }}>
        {open ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <SenderAddress from={u.from} />
              <Recipients message={message} />
            </div>
            <MessageBody message={message} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function GmailThread(p: GmailThreadProps) {
  const [unfolded, setUnfolded] = useState(false);
  const firstRevealed = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef(false);

  useLayoutEffect(() => {
    if (!unfolded || !focusNext.current) return;
    focusNext.current = false;
    firstRevealed.current?.focus();
  }, [unfolded]);

  const n = p.messages.length;
  const labels = mergeLabels(p.messages.map((m) => m.labels));
  const starred = p.messages.some((m) => m.starred);

  if (p.view === "structured") {
    return (
      <div style={{ width: "100%", minWidth: 0 }}>
        <Surface pad={0}>
          <section className="bk-gm-frame" aria-label="Gmail thread" data-gmail-thread="structured">
            <header style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3 }}>
              <h3 style={H3}>{`Thread · ${plural(n, "message")}`}</h3>
              <span style={{ ...META, color: color.inkDim }} data-gmail-view-line="">
                {STRUCTURED_LINE}
              </span>
            </header>
            <ul className="bk-gm-list">
              {p.messages.map((m) => (
                <StructuredRow key={m.messageId} item={m} attachments={m.attachmentCount} />
              ))}
            </ul>
          </section>
        </Surface>
      </div>
    );
  }

  const messages = p.messages;
  const subject = messages.find((m) => m.untrusted.subject)?.untrusted.subject ?? null;
  const earlier = n - 1;
  const folded = !unfolded && earlier >= FOLD_FROM ? earlier - KEEP_EARLIER : 0;

  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <Surface pad={0}>
        <section className="bk-gm-frame" aria-label={subject ? `Email thread: ${accessibleName(subject)}` : "Email thread"} data-gmail-thread="content">
          <header style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
            <h3 className="bk-gm-clamp-2" style={H3}>
              {subject ? <Field text={subject} /> : <span style={{ fontStyle: "italic", fontWeight: 400, color: color.inkMute }}>— no subject</span>}
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", minWidth: 0 }}>
              <span style={META}>{plural(n, "message")}</span>
              <GmailLabels labels={labels} />
              <Flags flags={{ starred }} />
            </div>
            <span style={PROVENANCE} data-gmail-view-line="">
              {CONTENT_LINE}
            </span>
          </header>
          {n === 0 ? (
            <p style={{ margin: 0, padding: "10px 14px 14px", borderTop: `1px solid ${color.line}`, font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>— Gmail returned no messages for this thread.</p>
          ) : (
            <ol className="bk-gm-list" aria-label="Messages, oldest first">
              {folded > 0 ? (
                <li style={{ borderTop: `1px solid ${color.line}` }}>
                  <button
                    type="button"
                    className="bk-row bk-gm-crow"
                    onClick={() => {
                      focusNext.current = true;
                      setUnfolded(true);
                    }}
                    data-gmail-fold=""
                  >
                    <span aria-hidden="true" />
                    <span className="bk-gm-crow-main" style={{ font: `500 12.5px/1.4 ${font.body}`, color: color.inkDim }}>
                      {`Show ${plural(folded, "earlier message")}`}
                    </span>
                    <span aria-hidden="true" className="bk-gm-crow-chevron">
                      <Icon icon="collapse" size={14} />
                    </span>
                  </button>
                </li>
              ) : null}
              {messages.slice(folded).map((message, i) => (
                <MessageItem
                  key={message.messageId}
                  message={message}
                  initiallyOpen={folded + i === n - 1}
                  toggleRef={unfolded && i === 0 && earlier >= FOLD_FROM ? (el) => void (firstRevealed.current = el) : undefined}
                />
              ))}
            </ol>
          )}
        </section>
      </Surface>
    </div>
  );
}
