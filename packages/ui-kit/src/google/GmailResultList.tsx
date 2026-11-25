import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../primitives/Button.js";
import { Icon } from "../primitives/Icon.js";
import { Surface } from "../primitives/Surface.js";
import { color, font } from "../tokens.js";
import { GmailLabels } from "./GmailLabels.js";
import { mailboxLabel } from "./mail-text.js";
import {
  CAPS, CONTENT_LINE, Field, Flags, META, PROVENANCE, STRUCTURED_LINE, UnreadDot, When, plural, shownLabels, spoken,
  type GmailDate, type GmailFlags, type GmailLabel, type GmailSizeBucket,
} from "./shared.js";

/**
 * `GmailResultList` — the threads a Gmail search returned (#4209; design
 * brief §1, §2 and §6; rulings G1 and G5).
 *
 * The shell is `GitHubResultList`'s: one card, hairline rows in Gmail's
 * order (newest first), eight rows and then "Show n more" up to what the
 * tool returned, and an honest footnote. Only the rows differ by view.
 *
 * - **Structured** (G1): the header says once what the view holds —
 *   "Structured view · dates, labels and counts only. Brain didn't read these
 *   messages." — and no row carries a placeholder. A row is the date and the
 *   message count, the labels, then the flags as words. It does not expand:
 *   the payload has nothing more to show.
 * - **Content**: a row is the sender, the date, the subject, the snippet and
 *   a meta line, all written by others. It opens in place to the From, To
 *   and Cc headers as written, the whole snippet and every label. It never
 *   turns into the thread, which would need another read.
 *
 * The kit never shows a total Gmail did not return: with a next page, the
 * footnote says Gmail has more and how to get it.
 */
export interface GmailStructuredThread extends GmailFlags {
  threadId: string;
  /** The newest message's date (the payload's `latest_internal_date`). */
  date?: GmailDate | null;
  messageCount?: number | null;
  labels: readonly GmailLabel[];
  sizeBucket?: GmailSizeBucket | null;
}

export interface GmailContentThread extends GmailStructuredThread {
  /** Everything a third party wrote about the thread's newest message. */
  untrusted: {
    from: string | null;
    to: string | null;
    cc: string | null;
    subject: string | null;
    snippet: string | null;
  };
}

export type GmailResultListProps = {
  /** The query as the tool call sent it. */
  query?: string | null;
  /** The page has a next cursor: Gmail has more matches than these. */
  nextPage?: boolean;
  /** Rows shown before "Show more". Defaults to 8. */
  initial?: number;
} & ({ view: "structured"; threads: readonly GmailStructuredThread[] } | { view: "content"; threads: readonly GmailContentThread[] });

const BODY_TEXT = { font: `400 12px/1.5 ${font.body}`, color: color.inkMute } as const;

/** What a structured row says to a screen reader before its labels and flags. */
function structuredWhen(thread: Omit<GmailStructuredThread, "threadId">) {
  const parts: string[] = [];
  if (thread.date) parts.push(thread.date.short);
  if (thread.messageCount !== undefined && thread.messageCount !== null) parts.push(plural(thread.messageCount, "message"));
  return parts;
}

export function StructuredRow({ item, attachments }: { item: Omit<GmailStructuredThread, "threadId">; attachments?: number | null }) {
  const when = structuredWhen(item);
  const bold = item.unread ? 650 : 500;
  return (
    <li className="bk-gm-srow" data-gmail-row="structured">
      <UnreadDot unread={item.unread} />
      <span className="bk-gm-when" style={{ font: `${bold} 12.5px/1.4 ${font.body}`, color: color.ink, overflowWrap: "anywhere" }}>
        {item.date ? <When date={item.date} /> : null}
        {when.length === 2 ? " · " : null}
        {item.messageCount !== undefined && item.messageCount !== null ? (
          <span style={{ fontWeight: 400, color: color.inkDim }}>{plural(item.messageCount, "message")}</span>
        ) : null}
      </span>
      <GmailLabels labels={item.labels} />
      <Flags flags={item} size={item.sizeBucket} attachments={attachments} />
    </li>
  );
}

/** The words a content row's button is named by. */
function contentName(thread: GmailContentThread, sender: string | null) {
  const parts: string[] = [];
  if (thread.unread) parts.push("Unread");
  parts.push(sender ?? "Sender not given");
  parts.push(thread.untrusted.subject ? spoken(thread.untrusted.subject) : "no subject");
  if (thread.date) parts.push(thread.date.full);
  if (thread.messageCount !== undefined && thread.messageCount !== null) parts.push(plural(thread.messageCount, "message"));
  if (thread.starred) parts.push("starred");
  if (thread.hasAttachment) parts.push("has an attachment");
  return parts.join(", ");
}

function Header({ name, value }: { name: string; value: string | null }) {
  if (value === null || value === "") return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span style={CAPS}>{name}</span>
      <span style={{ font: `400 12px/1.5 ${font.body}`, color: color.ink }}>
        <Field text={value} />
      </span>
    </div>
  );
}

function ContentRow({ thread }: { thread: GmailContentThread }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const u = thread.untrusted;
  const sender = u.from ? spoken(mailboxLabel(u.from)) : null;
  const weight = thread.unread ? 650 : 500;
  const labels = shownLabels(thread.labels);
  const count = thread.messageCount !== undefined && thread.messageCount !== null ? plural(thread.messageCount, "message") : null;
  return (
    <li style={{ borderTop: `1px solid ${color.line}` }} data-gmail-row="content">
      <button type="button" className="bk-row bk-gm-crow" aria-expanded={open} aria-controls={panel} aria-label={contentName(thread, sender)} onClick={() => setOpen(!open)}>
        <UnreadDot unread={thread.unread} />
        <span className="bk-gm-crow-main">
          <span className="bk-gm-line">
            <span className="bk-gm-grow" style={{ font: `${weight} 12.5px/1.4 ${font.body}`, color: color.ink }}>
              {u.from ? <Field text={mailboxLabel(u.from)} /> : <span style={{ fontStyle: "italic", fontWeight: 400, color: color.inkMute }}>— sender not given</span>}
            </span>
            {thread.date ? <When date={thread.date} style={{ ...META, color: thread.unread ? color.ink : color.inkMute }} /> : null}
          </span>
          <span className="bk-gm-clamp-2 bk-gm-subject" style={{ font: `${weight} 12.5px/1.4 ${font.body}`, color: color.ink }}>
            {u.subject ? <Field text={u.subject} /> : <span style={{ fontStyle: "italic", fontWeight: 400, color: color.inkMute }}>— no subject</span>}
          </span>
          {u.snippet ? (
            <span className="bk-gm-clamp-2" style={{ font: `400 12px/1.5 ${font.body}`, color: color.inkDim }}>
              <Field text={u.snippet} />
            </span>
          ) : null}
          {count || labels.length > 0 || thread.starred || thread.hasAttachment ? (
            <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", marginTop: 2 }}>
              {count ? <span style={META}>{count}</span> : null}
              <GmailLabels labels={thread.labels} static />
              <Flags flags={{ starred: thread.starred, hasAttachment: thread.hasAttachment }} />
            </span>
          ) : null}
        </span>
        <span aria-hidden="true" className="bk-gm-crow-chevron">
          <Icon icon={open ? "collapse" : "next"} size={14} />
        </span>
      </button>
      {open ? (
        <div id={panel} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 14px 12px 30px", minWidth: 0 }} data-gmail-row-panel="">
          <Header name="From" value={u.from} />
          <Header name="To" value={u.to} />
          <Header name="Cc" value={u.cc} />
          {u.snippet ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <span style={CAPS}>Snippet</span>
              <span className="bk-gm-body" style={{ font: `400 12px/1.6 ${font.body}`, color: color.ink }}>
                <Field text={u.snippet} />
              </span>
            </div>
          ) : null}
          {labels.length > 0 ? <GmailLabels labels={thread.labels} limit={Number.POSITIVE_INFINITY} /> : null}
        </div>
      ) : null}
    </li>
  );
}

export function GmailResultList(p: GmailResultListProps) {
  const initial = p.initial ?? 8;
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const focusFrom = useRef<number | null>(null);
  const total = p.threads.length;
  const shownCount = all ? total : Math.min(initial, total);
  const hidden = total - shownCount;

  useLayoutEffect(() => {
    if (focusFrom.current === null) return;
    const row = list.current?.children[focusFrom.current] as HTMLElement | undefined;
    focusFrom.current = null;
    if (!row) return;
    // A content row's own toggle; a structured row is not a control, so the row itself (never a label's "+N").
    const target = row.querySelector<HTMLElement>(":scope > button") ?? row;
    if (target === row) row.tabIndex = -1;
    target.focus();
  }, [all]);

  return (
    // The card fills its column: in a start-aligned flex parent a Surface
    // alone would shrink to its content.
    <div style={{ width: "100%", minWidth: 0 }}>
      <Surface pad={0}>
        <section className="bk-gm-frame" aria-label="Gmail search results" data-gmail-results={p.view} style={{ display: "flex", flexDirection: "column" }}>
          <header style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3 }}>
            <h3 style={{ margin: 0, font: `650 13.5px/1.35 ${font.body}`, color: color.ink }}>{plural(total, "thread")}</h3>
            {p.query ? (
              <span style={META}>
                “<Field text={p.query} />” · newest first
              </span>
            ) : null}
            <span style={p.view === "structured" ? { ...META, color: color.inkDim } : PROVENANCE} data-gmail-view-line="">
              {p.view === "structured" ? STRUCTURED_LINE : CONTENT_LINE}
            </span>
          </header>
          {total === 0 ? (
            <p style={{ margin: 0, padding: "10px 14px 14px", borderTop: `1px solid ${color.line}`, ...BODY_TEXT }}>— Gmail found nothing for this search.</p>
          ) : (
            <ul ref={list} className="bk-gm-list">
              {p.view === "structured"
                ? p.threads.slice(0, shownCount).map((thread) => <StructuredRow key={thread.threadId} item={thread} />)
                : p.threads.slice(0, shownCount).map((thread) => <ContentRow key={thread.threadId} thread={thread} />)}
            </ul>
          )}
          {hidden > 0 || p.nextPage ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px 12px", borderTop: `1px solid ${color.line}` }}>
              {hidden > 0 ? (
                <Button
                  label={`Show ${hidden} more · ${shownCount} of ${total} shown`}
                  tone="ghost"
                  size="md"
                  reach
                  onClick={() => {
                    focusFrom.current = shownCount;
                    setAll(true);
                  }}
                />
              ) : null}
              {p.nextPage ? (
                <span style={META} data-gmail-footnote="">
                  Gmail has more matches. Ask Brain for the next page.
                </span>
              ) : null}
            </div>
          ) : null}
        </section>
      </Surface>
    </div>
  );
}
