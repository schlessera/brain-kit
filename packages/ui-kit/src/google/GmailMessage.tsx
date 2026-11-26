import { useId, useLayoutEffect, useRef, useState } from "react";
import { DetailSection } from "../evidence/DetailSection.js";
import { UntrustedText } from "../evidence/UntrustedText.js";
import { Icon } from "../primitives/Icon.js";
import { Surface } from "../primitives/Surface.js";
import { color, font } from "../tokens.js";
import { GmailLabels } from "./GmailLabels.js";
import { StructuredRow } from "./GmailResultList.js";
import { mailboxLabels, readMailbox, splitMailboxes, splitQuotedTail } from "./mail-text.js";
import {
  CONTENT_LINE, Field, Flags, MAIL_SOURCE, META, PROVENANCE, STRUCTURED_LINE_ONE, UnreadDot, When, accessibleName, count, fileSize, plural, spoken,
  type GmailDate, type GmailFlags, type GmailLabel, type GmailSizeBucket,
} from "./shared.js";

/**
 * `GmailMessage` — one Gmail message (#4209; design brief §3, §4 and §6;
 * ruling G3), and the message body `GmailThread` draws for each message.
 *
 * The body is what the model saw, behind a provenance rule, clamped to six
 * lines (four below 480px) with an in-place control that only un-clamps
 * text already on screen.
 *
 * - **Quoted history** (G3): quote blocks at the very end of the body, with
 *   the "On … wrote:" line before them, fold behind "Show quoted text". A
 *   quote with the sender's own words after it stays where it is. The
 *   payload is unchanged; this is the kit's reading of it.
 * - **Truncation**: when the payload cut the body, one line says how much
 *   Brain read — "Brain read the first 32,768 of 49,152 characters." — and
 *   never changes. The payload's `bodyTruncated` decides: a body it cut is
 *   cut even when its length is missing or no longer than what arrived, and
 *   then the line names no total ("Brain read the first 32,768 characters
 *   of this message."). Under it, the rest loads on demand from the
 *   display-only route through the shared detail section (G2), which says
 *   the rest stays out of Brain's reading. A cut body never folds its
 *   quote: what looks like its end is not the message's end.
 * - **Focus**: a control that removes itself — "Show whole message", the
 *   rest's "Show the rest", "Try again" — would drop focus to the page. It
 *   moves to the message body instead (a labelled group, `tabIndex -1`), so
 *   the reader carries on from where the text is. The shared detail section
 *   is unchanged: GitHub's keeps its own behaviour.
 * - **Links** in the body keep the full-address interstitial. It names no
 *   author: a From header is a claim anyone can write.
 */
export interface GmailAttachment {
  filename: string | null;
  mimeType: string | null;
  /** Bytes. */
  size: number | null;
}

export interface GmailStructuredMessage extends GmailFlags {
  messageId: string;
  date?: GmailDate | null;
  labels: readonly GmailLabel[];
  sizeBucket?: GmailSizeBucket | null;
  attachmentCount?: number | null;
}

/** The on-demand rest of a body the payload cut, as the host's detail route answered. */
export type GmailDetailState = "idle" | "loading" | "loaded" | "error" | "rate-limited" | "unavailable" | "gone";

export interface GmailBodyDetail {
  state: GmailDetailState;
  /** Once loaded: the text after what Brain read. */
  rest?: string | null;
  /** The display route cut the body at its own bound. */
  restTruncated?: boolean;
  /** `error`: what Gmail answered, e.g. 502. */
  errorStatus?: number | string;
  /** `rate-limited`: when the limit resets, and how long until then. */
  resetAt?: string;
  resetIn?: string;
  onLoad?: () => void;
  onRetry?: () => void;
}

export interface GmailContentMessage extends GmailStructuredMessage {
  /** Everything a third party wrote about the message. Never instructions. */
  untrusted: {
    from: string | null;
    to: string | null;
    cc: string | null;
    bcc?: string | null;
    subject: string | null;
    snippet: string | null;
    /** The text body Brain read, capped by the payload. */
    body: string | null;
    /** The payload cut the body. Authoritative: a cut body is shown as cut whatever `bodyLength` says. */
    bodyTruncated: boolean;
    /** The whole body's length in characters. `null` (or no more than `body`'s length) when the payload did not say. */
    bodyLength: number | null;
    attachments: readonly GmailAttachment[];
  };
  /** The rest of a cut body, when the host offers it. */
  detail?: GmailBodyDetail;
}

export type GmailMessageProps =
  | { view: "content"; message: GmailContentMessage }
  | { view: "structured"; message: GmailStructuredMessage };

const MUTED_ITALIC = { fontStyle: "italic", color: color.inkMute } as const;

/** "to Odysseus, Telemachus · cc Eumaeus": who else the message went to, by name. */
export function Recipients({ message }: { message: GmailContentMessage }) {
  const u = message.untrusted;
  const parts: [string, string][] = [];
  if (u.to) parts.push(["to", mailboxLabels(u.to).join(", ")]);
  if (u.cc) parts.push(["cc", mailboxLabels(u.cc).join(", ")]);
  if (u.bcc) parts.push(["bcc", mailboxLabels(u.bcc).join(", ")]);
  if (parts.length === 0) return null;
  return (
    <div style={{ font: `400 11.5px/1.5 ${font.body}`, color: color.inkMute, minWidth: 0 }} data-gmail-recipients="">
      {parts.map(([word, names], i) => (
        <span key={word}>
          {i > 0 ? " · " : null}
          {word} <Field text={names} style={{ color: color.inkDim }} />
        </span>
      ))}
    </div>
  );
}

/** The sender's address under their name, when the From header gave both. */
export function SenderAddress({ from }: { from: string | null }) {
  if (!from) return null;
  const first = splitMailboxes(from)[0];
  const reading = first ? readMailbox(first) : null;
  if (!reading?.name || !reading.address) return null;
  return (
    <div style={{ ...META, overflowWrap: "anywhere" }}>
      <Field text={reading.address} />
    </div>
  );
}

function Attachments({ items }: { items: readonly GmailAttachment[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="bk-gm-list" aria-label={items.length === 1 ? "Attachment" : `${items.length} attachments`} style={{ gap: 4 }} data-gmail-attachments="">
      {items.map((item, i) => (
        <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0, font: `400 12px/1.5 ${font.body}`, color: color.ink }}>
          <span aria-hidden="true" style={{ display: "inline-flex", paddingTop: 3, color: color.inkMute }}>
            <Icon icon="attach" size={12} />
          </span>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {item.filename ? (
              <Field text={item.filename} />
            ) : item.mimeType ? (
              <Field text={item.mimeType} style={{ font: `400 11.5px/1.5 ${font.mono}` }} />
            ) : (
              <span style={MUTED_ITALIC}>— no file name</span>
            )}
            <span style={META}>{`${item.size !== null ? ` · ${fileSize(item.size)}` : ""} · not loaded`}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What Brain read of a cut body; `total` is `null` when the payload gave no usable length. It never changes when the reader loads the rest. */
function readLine(shown: number, total: number | null) {
  if (total === null) return shown === 0 ? "Brain read none of this message." : `Brain read the first ${count(shown)} characters of this message.`;
  return shown === 0
    ? `Brain read none of this message's ${count(total)} characters.`
    : `Brain read the first ${count(shown)} of ${count(total)} characters.`;
}

/** A message's body, quoted history, truncation, on-demand rest and attachments. */
export function MessageBody({ message }: { message: GmailContentMessage }) {
  const u = message.untrusted;
  const raw = u.body ?? "";
  // The payload's flag decides whether the body was cut; its length only says by how much, when it can.
  const cut = u.bodyTruncated;
  const total = u.bodyLength !== null && u.bodyLength > raw.length ? u.bodyLength : null;
  const detail = message.detail;
  const split = cut ? null : splitQuotedTail(raw);
  const [quotedOpen, setQuotedOpen] = useState(false);
  const quotedId = useId();
  // Asking for the rest means reading on: the part Brain read stops clamping.
  const clamp = !cut || !detail || detail.state === "idle";
  const main = split ? split.body : raw;

  // A control the reader pressed that then removes itself would leave focus on
  // the page; the body takes it instead. UntrustedText's own "Show whole
  // message" re-renders only itself, so a timer looks once that commit is in;
  // a host that answers Load with a new detail state re-renders this, and the
  // layout effect looks then.
  const region = useRef<HTMLDivElement>(null);
  const pressed = useRef<HTMLElement | null>(null);
  const keepFocus = () => {
    const control = pressed.current;
    if (!control || control.isConnected) return;
    pressed.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) region.current?.focus();
  };
  useLayoutEffect(keepFocus);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const press = (target: EventTarget) => {
    pressed.current = (target as Element).closest<HTMLElement>("button, [role='button']");
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(keepFocus, 0);
  };

  return (
    <div
      ref={region}
      role="group"
      aria-label="Message body"
      tabIndex={-1}
      className="bk-gm-message-body"
      style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}
      data-gmail-message-body=""
      onClickCapture={(event) => press(event.target)}
      // The kit's Button acts on Enter and Space at keydown, with no click.
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" || event.key === " ") press(event.target);
      }}
      onFocusCapture={(event) => {
        // Focus that moved on by itself is the reader's; nothing pending survives it.
        if (event.target !== pressed.current) pressed.current = null;
      }}
    >
      {raw === "" && !cut ? (
        <p style={{ margin: 0, font: `400 12px/1.5 ${font.body}`, ...MUTED_ITALIC }}>— This message has no text body.</p>
      ) : null}
      {main !== "" ? (
        <div className="bk-gm-body" data-gmail-body="">
          <UntrustedText
            key={clamp ? "clamped" : "open"}
            text={spoken(main)}
            {...MAIL_SOURCE}
            frame="none"
            {...(clamp ? { lines: 6, linesNarrow: 4 } : {})}
            expandLabel={cut ? "Show what Brain read" : "Show whole message"}
          />
          {split ? (
            <>
              <button
                type="button"
                className="bk-text-btn"
                data-tone="inherit"
                aria-expanded={quotedOpen}
                aria-controls={quotedId}
                onClick={() => setQuotedOpen(!quotedOpen)}
                style={{ alignSelf: "flex-start", font: `500 12px/20px ${font.body}`, color: color.inkDim, textDecoration: "none" }}
                data-gmail-quoted-toggle=""
              >
                <span aria-hidden="true" style={{ font: `600 12px/1 ${font.mono}`, letterSpacing: ".1em", marginInlineEnd: 6 }}>
                  ···
                </span>
                {quotedOpen ? "Hide quoted text" : "Show quoted text"}
              </button>
              <div id={quotedId} hidden={!quotedOpen} data-gmail-quoted="">
                {quotedOpen ? <UntrustedText text={spoken(split.attribution ? `${split.attribution}\n\n${split.quoted}` : split.quoted)} {...MAIL_SOURCE} frame="none" /> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {cut ? (
        <>
          <div style={META} data-brain-read="">
            {readLine(raw.length, total)}
          </div>
          {detail ? (
            <DetailSection
              state={detail.state}
              source="Gmail"
              noun="the rest of this message"
              object="message"
              idleLabel={total === null ? "Show the rest" : `Show the rest · ${plural(total - raw.length, "character")}`}
              pronoun="this"
              reach
              attribute="data-gmail-detail"
              errorStatus={detail.errorStatus}
              resetAt={detail.resetAt}
              resetIn={detail.resetIn}
              onLoad={detail.onLoad}
              onRetry={detail.onRetry}
            >
              {detail.state === "loaded" && detail.rest ? (
                <div className="bk-gm-body" data-gmail-rest="">
                  <UntrustedText
                    text={spoken(detail.rest)}
                    {...MAIL_SOURCE}
                    frame="none"
                    truncated={detail.restTruncated}
                    truncatedNote="Cut at this view's limit of 1,048,576 characters."
                  />
                </div>
              ) : undefined}
            </DetailSection>
          ) : null}
        </>
      ) : null}
      <Attachments items={u.attachments} />
    </div>
  );
}

/** The sender as a reader knows them, or `null` when the From header is empty. */
export function senderLabel(from: string | null): string | null {
  const first = from ? splitMailboxes(from)[0] : undefined;
  if (!first) return null;
  const reading = readMailbox(first);
  return reading.name ?? reading.address ?? first;
}

export function GmailMessage(p: GmailMessageProps) {
  if (p.view === "structured") {
    const m = p.message;
    return (
      <div style={{ width: "100%", minWidth: 0 }}>
        <Surface pad={0}>
          <section className="bk-gm-frame" aria-label="Gmail message" data-gmail-message="structured">
            <header style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3 }}>
              <h3 style={{ margin: 0, font: `650 13.5px/1.35 ${font.body}`, color: color.ink }}>1 message</h3>
              <span style={{ ...META, color: color.inkDim }} data-gmail-view-line="">
                {STRUCTURED_LINE_ONE}
              </span>
            </header>
            <ul className="bk-gm-list">
              <StructuredRow item={m} attachments={m.attachmentCount} />
            </ul>
          </section>
        </Surface>
      </div>
    );
  }

  const m = p.message;
  const u = m.untrusted;
  const name = senderLabel(u.from);
  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <Surface pad={0}>
        <article className="bk-gm-frame" aria-label={`Email${name ? ` from ${accessibleName(name)}` : ""}`} data-gmail-message="content">
          <header style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, borderBottom: `1px solid ${color.line}` }}>
            <h3 className="bk-gm-clamp-2" style={{ margin: 0, font: `650 13.5px/1.35 ${font.body}`, color: color.ink }}>
              {u.subject ? <Field text={u.subject} /> : <span style={{ ...MUTED_ITALIC, fontWeight: 400 }}>— no subject</span>}
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", minWidth: 0 }}>
              <GmailLabels labels={m.labels} />
              <Flags flags={{ starred: m.starred }} attachments={m.attachmentCount} size={m.sizeBucket} />
            </div>
            <span style={PROVENANCE} data-gmail-view-line="">
              {CONTENT_LINE}
            </span>
          </header>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px 14px", minWidth: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <div className="bk-gm-head">
                <span className="bk-gm-grow" style={{ display: "inline-flex", alignItems: "center", gap: 7, font: `${m.unread ? 650 : 600} 12.5px/1.4 ${font.body}`, color: color.ink }}>
                  {m.unread ? <UnreadDot unread /> : null}
                  {m.unread ? <span className="bk-sr-only">Unread, </span> : null}
                  {name ? <Field text={name} /> : <span style={{ ...MUTED_ITALIC, fontWeight: 400 }}>— sender not given</span>}
                </span>
                {m.date ? <When date={m.date} style={META} /> : null}
              </div>
              <SenderAddress from={u.from} />
              <Recipients message={m} />
            </div>
            <MessageBody message={m} />
          </div>
        </article>
      </Surface>
    </div>
  );
}
