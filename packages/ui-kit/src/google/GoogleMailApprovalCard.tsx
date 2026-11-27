import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ApprovalCard } from "../decisions/ApprovalCard.js";
import { Callout } from "../primitives/Callout.js";
import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import {
  GOOGLE_ALWAYS_NOTE, GOOGLE_REVERSIBLE_RISK, GOOGLE_SESSION_NOTE, GOOGLE_TAINT_BANNER, bodyChanges, bodyHeader, bodyLines, bodyRegionName, deltaLine,
  envelopeSummary, googleApprovalKeys, googleBadge, hiddenSummary, lineSegments, linesBelow, messages, modifyActions, modifyWords, moreLines,
  repliesElsewhere, standingLabel, unchangedLines, type ChangeRow, type DeltaLine, type GoogleEffect,
} from "./mail-approval.js";
import { CAPS, Field, META, PROVENANCE, Segments, When, plural, shownLabels, spoken, type GmailDate, type GmailLabel, type GoogleHostTime } from "./shared.js";

/**
 * `GoogleMailApprovalCard` — the approval card for one Gmail write (#4215,
 * epic #4201; design brief of 2026-11-20, rulings of 2026-11-24 M1–M6).
 *
 * The shell is `ApprovalCard`, unchanged in layout: the head, the amber
 * treatment, the payload, the risk line just above the buttons, Allow taking
 * the remaining width and Deny at its 96 × 44 floor. This component chooses
 * the words and draws the payload; the host prepares the payload and decides.
 * It is presentational: props and callbacks only, no client and no store.
 *
 * - **Exactly what is sent.** A send shows From, every recipient with its
 *   send-list match, Bcc on its own emphasised row, Reply-To, the subject,
 *   the thread it replies to and the whole body. Nothing is clamped or
 *   summarised. A long body scrolls inside the card, behind a sticky
 *   "↓ n more lines" cue, and Allow stays enabled (M3).
 * - **Irreversible is different in words, glyph and what is absent**: its
 *   badge says it can't be undone, its risk line says what it does, Allow
 *   names the verb and the object, and there is no standing choice and no
 *   `a` key, neither printed nor bound (M4, `googleApprovalKeys`). Sending,
 *   deleting a draft and trashing are always irreversible; a modify or a
 *   draft save is whatever the host classified it as.
 * - **A reversible card** offers the one standing choice its chat allows,
 *   under the buttons, as its own row with a note saying where it lives.
 * - **A tainted chat** puts the taint banner above the payload (M5).
 * - **Untrusted text** (addresses, display names, the subject, the
 *   In-Reply-To ids, the thread's subject, an affected message's sender and
 *   subject) is drawn through `Field`: isolated, with every hidden character
 *   shown as its marker. The head's send-as address shows its markers too.
 *   Gmail's message and draft ids, which the host validates, are plain text.
 * - **The body is drawn literally** (#4215 F1, plan §4: a send is bound to
 *   the exact approved bytes): one numbered row per line, every character as
 *   written, blank lines, indentation, runs of spaces and tabs kept, long
 *   lines wrapped, hidden characters as markers. It is never read as
 *   Markdown and holds no link: a URL is text the reader reads in full.
 */

/** A parsed mailbox, as the host's card carries it: the canonical address and the display name the draft gave. */
export interface GoogleMailbox {
  address: string;
  displayName: string | null;
}

/** The complete parsed message a card shows. Every field is what the host will send or save, untruncated. */
export interface GoogleMailMessage {
  from: GoogleMailbox;
  to: readonly GoogleMailbox[];
  cc: readonly GoogleMailbox[];
  bcc: readonly GoogleMailbox[];
  replyTo: readonly GoogleMailbox[];
  subject: string | null;
  /** The In-Reply-To message ids, as the draft's header carries them. */
  inReplyTo: readonly string[];
  /** The whole plain-text body. */
  body: string;
}

/** One recipient's send-list match: the policy entry it matched as written ("self", "*@example.com"), or `null` for none. */
export interface GoogleRecipientMatch {
  field: "to" | "cc" | "bcc";
  address: string;
  entry: string | null;
}

/** The thread a message replies to, as the host shows it. Its subject is text a stranger may have written. */
export interface GoogleMailThread {
  subject: string | null;
  date: GmailDate | null;
}

/** One message a trash or modify affects. Everything but the id is optional: the host shows what it has. */
export interface GoogleMailTarget {
  messageId: string;
  date?: GmailDate | null;
  labels?: readonly GmailLabel[];
  /** The sender, as written: untrusted. */
  from?: string | null;
  /** The subject, as written: untrusted. */
  subject?: string | null;
}

/** Which standing choices the host offers, as the card's `offers` carries them. */
export interface GoogleStandingOffers {
  allowAlways: boolean;
  allowForSession: boolean;
}

interface Shared {
  /** The chat has read text others wrote: the taint banner shows, and only a chat allowance can stand. */
  tainted: boolean;
  onAllow?: () => void;
  onDeny?: () => void;
  /** Print the single keys (a fine pointer with shortcuts on). Which keys exist is `googleApprovalKeys`'s, never the host's. */
  shortcuts?: boolean;
}

interface Standing {
  offers?: GoogleStandingOffers;
  /** The standing choice was pressed: "Always allow …" untainted, "Allow … for this chat" tainted. */
  onStanding?: () => void;
}

export interface GoogleMailSendProps extends Shared {
  operation: "gmail.draft.send";
  /** Always irreversible; accepted so a card can be spread in, and ignored. */
  effect?: "irreversible";
  /** The verified send-as identity the host sends as. */
  sendAs: GoogleMailbox;
  /** The account's alias in the owner's policy. */
  accountAlias?: string;
  message: GoogleMailMessage;
  threadId: string | null;
  /** The thread replied to, when the host shows it. */
  thread?: GoogleMailThread | null;
  /** Each recipient's match. Absent from an earlier card producer: then no match is drawn. */
  recipientMatches?: readonly GoogleRecipientMatch[];
}

export interface GoogleMailDraftSaveProps extends Shared, Standing {
  operation: "gmail.draft.save";
  effect: GoogleEffect;
  action: "create" | "reply" | "update";
  draftId: string | null;
  threadId: string | null;
  message: GoogleMailMessage;
  thread?: GoogleMailThread | null;
  /** An update: the body it replaces, for the change above the new body. */
  previousBody?: string | null;
  /** An update: when the replaced draft was saved. */
  replacedAt?: GoogleHostTime | null;
}

export interface GoogleMailDraftDeleteProps extends Shared {
  operation: "gmail.draft.delete";
  effect?: "irreversible";
  draftId: string;
  /** The draft's message, when the host shows it. */
  message?: GoogleMailMessage | null;
}

export interface GoogleMailTrashProps extends Shared {
  operation: "gmail.trash";
  effect?: "irreversible";
  messages: readonly GoogleMailTarget[];
  /** How many threads the messages are in, when the host counted them. */
  threads?: number | null;
}

export interface GoogleMailModifyProps extends Shared, Standing {
  operation: "gmail.modify";
  effect: GoogleEffect;
  messages: readonly GoogleMailTarget[];
  addLabels: readonly GmailLabel[];
  removeLabels: readonly GmailLabel[];
  threads?: number | null;
}

export type GoogleMailApprovalCardProps =
  | GoogleMailSendProps
  | GoogleMailDraftSaveProps
  | GoogleMailDraftDeleteProps
  | GoogleMailTrashProps
  | GoogleMailModifyProps;

/** How many affected messages show before "+N more". */
const FIRST = 5;

const MUTED_ITALIC: CSSProperties = { fontStyle: "italic", color: color.inkMute };
const MONO: CSSProperties = { font: `500 11.5px/1.45 ${font.mono}` };
const LINE: CSSProperties = { margin: 0, font: `400 12px/1.5 ${font.body}`, color: color.ink };
const RISK: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 9, font: `400 10.5px/1.5 ${font.mono}`, color: accent.gold.ink };
const GOLD_LINE: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 6, font: `400 10.5px/1.5 ${font.mono}`, color: accent.gold.ink };

/* ── The taint banner ─────────────────────────────────────────────────── */

/** M5: above the payload, read before it. Purple, the colour of others' words, with the words saying it too. */
function TaintBanner() {
  return (
    <div role="note" data-google-taint-banner="">
      <Callout tone="purple" variant="banner" icon="fyi" text={GOOGLE_TAINT_BANNER} />
    </div>
  );
}

/* ── The envelope ─────────────────────────────────────────────────────── */

function Match({ match }: { match: GoogleRecipientMatch | undefined | null }) {
  if (match === undefined) return null;
  if (match === null || match.entry === null) {
    // The host refuses a recipient off the send list before any card (M6), so this is a host bug, drawn as one.
    return (
      <span className="bk-gma-match" style={{ color: accent.red.ink }} data-google-match-missing="">
        <Icon icon="failed" size={11} />
        not on your send list
      </span>
    );
  }
  return (
    <span className="bk-gma-match" style={{ color: accent.teal.ink }} data-google-match={match.entry}>
      <Icon icon="confirm" size={11} />
      <bdi>{match.entry}</bdi>
    </span>
  );
}

/** One address: the address first, in mono, then the display name, dim and quoted, so a name can never stand in for an address. */
function Address({ mailbox, match, field }: { mailbox: GoogleMailbox; match?: GoogleRecipientMatch | null; field: string }) {
  return (
    <div className="bk-gma-addr" data-google-recipient={field}>
      <span className="bk-gma-who">
        <Field text={mailbox.address} style={MONO} />
        {mailbox.displayName ? (
          <span style={{ color: color.inkMute, font: `400 11.5px/1.45 ${font.body}` }}>
            {" “"}
            <Field text={mailbox.displayName} />
            {"”"}
          </span>
        ) : null}
      </span>
      <Match match={match} />
    </div>
  );
}

function matchFor(matches: readonly GoogleRecipientMatch[] | undefined, field: "to" | "cc" | "bcc", address: string): GoogleRecipientMatch | null | undefined {
  if (!matches) return undefined;
  const lower = address.toLowerCase();
  return matches.find((m) => m.field === field && m.address.toLowerCase() === lower) ?? null;
}

function InReplyTo({ thread, inReplyTo, threadId }: { thread?: GoogleMailThread | null; inReplyTo: readonly string[]; threadId: string | null }) {
  if (thread) {
    return (
      <div style={LINE}>
        {thread.subject ? <Field text={thread.subject} /> : <span style={MUTED_ITALIC}>— no subject</span>}
        {thread.date ? (
          <span style={META}>
            {" · "}
            <When date={thread.date} />
          </span>
        ) : null}
      </div>
    );
  }
  if (inReplyTo.length > 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        {inReplyTo.map((id, i) => (
          <Field key={i} text={id} style={{ ...MONO, color: color.inkDim }} />
        ))}
      </div>
    );
  }
  return <div style={{ ...LINE, color: color.inkMute }}>{threadId ? "an existing conversation" : "new conversation"}</div>;
}

function Envelope(p: {
  message: GoogleMailMessage;
  /** A send: the summary says who gets it, and each recipient shows its match. */
  sends: boolean;
  matches?: readonly GoogleRecipientMatch[];
  sendAs?: GoogleMailbox;
  thread?: GoogleMailThread | null;
  threadId: string | null;
  /** Show "In reply to" even when there is nothing to reply to ("new conversation"). */
  replyRow: boolean;
}) {
  const m = p.message;
  const fromMatch: GoogleRecipientMatch | undefined =
    p.sendAs && p.sendAs.address.toLowerCase() === m.from.address.toLowerCase() ? { field: "to", address: m.from.address, entry: "self" } : undefined;
  const hidden = hiddenSummary([
    ["From", [m.from.address, m.from.displayName]],
    ["To", m.to.flatMap((x) => [x.address, x.displayName])],
    ["Cc", m.cc.flatMap((x) => [x.address, x.displayName])],
    ["Bcc", m.bcc.flatMap((x) => [x.address, x.displayName])],
    ["Reply-To", m.replyTo.flatMap((x) => [x.address, x.displayName])],
    ["Subject", [m.subject]],
    ["In reply to", [p.thread?.subject, ...(p.thread ? [] : m.inReplyTo)]],
  ]);
  const rows = (field: "to" | "cc" | "bcc", list: readonly GoogleMailbox[]) =>
    list.map((mailbox, i) => <Address key={i} mailbox={mailbox} field={field} match={p.sends ? matchFor(p.matches, field, mailbox.address) : undefined} />);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }} data-google-envelope="">
      <div style={{ font: `600 12px/1.45 ${font.body}`, color: color.ink }} data-google-envelope-summary="">
        {envelopeSummary(m, p.sends)}
      </div>
      <dl className="bk-gma-env">
        <dt style={CAPS}>From</dt>
        <dd>
          <Address mailbox={m.from} field="from" match={fromMatch} />
        </dd>
        <dt style={CAPS}>To</dt>
        <dd>{m.to.length > 0 ? rows("to", m.to) : <span style={{ ...LINE, ...MUTED_ITALIC }}>— nobody</span>}</dd>
        {m.cc.length > 0 ? (
          <>
            <dt style={CAPS}>Cc</dt>
            <dd>{rows("cc", m.cc)}</dd>
          </>
        ) : null}
        {/* M2: an empty Bcc row is omitted, like Cc and Reply-To; a non-empty one is its own emphasised row. */}
        {m.bcc.length > 0 ? (
          <>
            <dt className="bk-gma-bcc" data-google-bcc="">
              <Icon icon="hidden-copy" size={12} color={accent.gold.ink} />
              <span>Bcc · hidden from the others</span>
            </dt>
            <dd>{rows("bcc", m.bcc)}</dd>
          </>
        ) : null}
        {m.replyTo.length > 0 ? (
          <>
            <dt style={CAPS}>Reply-To</dt>
            <dd>
              {m.replyTo.map((mailbox, i) => (
                <Address key={i} mailbox={mailbox} field="reply-to" />
              ))}
              {repliesElsewhere(m.from, m.replyTo) ? (
                <div style={GOLD_LINE} data-google-replies-elsewhere="">
                  Replies go here, not to From.
                </div>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt style={CAPS}>Subject</dt>
        <dd style={{ ...LINE, fontWeight: 600 }} data-google-subject="">
          {m.subject ? <Field text={m.subject} /> : <span style={{ ...MUTED_ITALIC, fontWeight: 400 }}>— no subject</span>}
        </dd>
        {p.replyRow || p.thread || m.inReplyTo.length > 0 ? (
          <>
            <dt style={CAPS}>In reply to</dt>
            <dd>
              <InReplyTo thread={p.thread} inReplyTo={m.inReplyTo} threadId={p.threadId} />
            </dd>
          </>
        ) : null}
      </dl>
      {hidden ? (
        <div style={GOLD_LINE} data-google-hidden-summary="">
          <Icon icon="failed" size={11} />
          <span>{hidden}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ── The body ─────────────────────────────────────────────────────────── */

const DRAFT_BOX: CSSProperties = {
  border: `1px solid ${token("provenance-border")}`,
  borderRadius: 10,
  background: color.surface,
  padding: "8px 0 0",
  minWidth: 0,
  overflow: "hidden",
};

/**
 * One body line as written (#4215 F1): every character, each run of spaces
 * and each tab taking its room (`break-spaces`: nothing collapses, nothing
 * hangs past the edge), a long line wrapping anywhere, and each hidden
 * character, a lone CR included, as its marker. Never Markdown, never a link.
 * The full body and an update's change rows both draw their lines with it.
 */
function LiteralText({ text, className, style }: { text: string; className?: string; style?: CSSProperties }) {
  return (
    <bdi className={className} style={{ whiteSpace: "break-spaces", overflowWrap: "anywhere", ...style }} data-untrusted-field="">
      <Segments segments={lineSegments(text)} />
    </bdi>
  );
}

/**
 * A body exactly as it will be sent or saved (plan §4): one row per line, in
 * mono, numbered. Blank lines are rows, a trailing line break leaves an empty
 * last row, and a wrapped line keeps its one number, so the rows are the
 * lines the header counts. The numbers are the card's, not the body's: hidden
 * from assistive technology and left out of a copy.
 */
function LiteralBody({ body }: { body: string }) {
  const lines = bodyLines(body);
  return (
    <div className="bk-gma-lines" style={{ "--bk-gma-digits": String(lines.length).length } as CSSProperties} data-google-body-text="">
      {lines.map((line, i) => (
        <div key={i} className="bk-gma-line" data-google-body-line={i + 1}>
          <span className="bk-gma-ln" aria-hidden="true" data-line-number="">
            {i + 1}
          </span>
          <LiteralText text={line} className="bk-gma-text" />
        </div>
      ))}
    </div>
  );
}

/**
 * The whole body, in a scroll region the keyboard can reach. Allow is never
 * gated on it (M3): the cue under the visible part only says how many lines
 * are not yet wholly in view, and goes once the end is.
 */
function ScrollBody({ body, caption }: { body: string; caption: string }) {
  const region = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scrolls: false, more: 0 });
  useLayoutEffect(() => {
    const el = region.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>("[data-google-body-line]");
    // The region is the rows' offset parent (`.bk-gma-scroll` is positioned), so a row's bottom is in its content's coordinates.
    const bottomOf = (i: number) => rows[i]!.offsetTop + rows[i]!.offsetHeight;
    const measure = () => {
      const scrolls = el.scrollHeight - el.clientHeight > 1;
      const more = scrolls ? linesBelow(rows.length, bottomOf, el.scrollTop + el.clientHeight) : 0;
      setView((v) => (v.scrolls === scrolls && v.more === more ? v : { scrolls, more }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => el.removeEventListener("scroll", measure);
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    if (el.firstElementChild) watch.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      watch.disconnect();
    };
  }, [body]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }} data-google-body="">
      <div style={META} data-google-body-header="">
        {bodyHeader(body)}
      </div>
      {body === "" ? (
        <p style={{ ...LINE, ...MUTED_ITALIC }}>— This draft has no text body.</p>
      ) : (
        <div style={DRAFT_BOX}>
          <div style={{ ...PROVENANCE, padding: "0 12px 4px" }}>{caption}</div>
          <div className="bk-gma-scroll-wrap">
            <div
              ref={region}
              className="bk-gma-scroll"
              role="group"
              aria-label={bodyRegionName(body)}
              tabIndex={view.scrolls ? 0 : undefined}
              data-google-body-region=""
              data-scrolls={view.scrolls ? "" : undefined}
            >
              <LiteralBody body={body} />
            </div>
            {view.more > 0 ? (
              <div className="bk-gma-more" aria-hidden="true" data-google-more-lines={view.more}>
                {moreLines(view.more)}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A draft about to be deleted: its first six rows, the last fading when there
 * is more, and "Show whole draft", which opens the rest in place. The same
 * literal rows as a send. Nothing is sent.
 */
function ClampedBody({ body }: { body: string }) {
  const clamp = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = clamp.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [open, body]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }} data-google-body="">
      <div style={META} data-google-body-header="">
        {bodyHeader(body)}
      </div>
      {body === "" ? (
        <p style={{ ...LINE, ...MUTED_ITALIC }}>— This draft has no text body.</p>
      ) : (
        <div style={{ ...DRAFT_BOX, padding: "8px 12px 6px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={PROVENANCE}>Saved draft · not sent</div>
          <div ref={clamp} className={open ? undefined : "bk-gma-clamp"} data-cut={!open && cut ? "" : undefined} data-google-body-clamp="">
            <LiteralBody body={body} />
          </div>
          {!open && cut ? (
            <button
              type="button"
              className="bk-text-btn"
              data-tone="inherit"
              aria-expanded={false}
              onClick={() => setOpen(true)}
              style={{ alignSelf: "flex-start", font: `500 12px/20px ${font.body}`, color: color.inkDim, textDecoration: "none" }}
            >
              Show whole draft
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

const SIGN_TINT: Record<"-" | "+", string> = { "-": token("diff-tint-red"), "+": token("diff-tint-teal") };
const SIGN_INK: Record<"-" | "+", string> = { "-": accent.red.ink, "+": accent.teal.ink };

/**
 * An update's body change: removed and added lines tinted, a line of context
 * around each, longer unchanged runs counted. Each row is a body line drawn
 * as the full body below draws it, so the two agree on every line.
 */
function BodyChanges({ rows }: { rows: readonly ChangeRow[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }} data-google-body-changes="">
      <div style={CAPS}>Changes to the body</div>
      {rows.length === 0 ? (
        <p style={{ ...LINE, color: color.inkMute }}>The body is unchanged.</p>
      ) : (
        <div style={{ borderRadius: 8, background: token("inset-well-bg"), padding: "8px 0", font: `400 10.5px/1.65 ${font.mono}`, minWidth: 0 }}>
          {rows.map((row, i) =>
            row.sign === "…" ? (
              <div key={i} style={{ padding: "1px 10px", color: color.inkMute }} data-sign="…">
                {`… ${unchangedLines(row.count)}`}
              </div>
            ) : (
              <div key={i} style={{ display: "flex", gap: 8, padding: "1px 10px", background: row.sign === " " ? "transparent" : SIGN_TINT[row.sign] }} data-sign={row.sign}>
                <span aria-hidden={row.sign === " " ? true : undefined} style={{ flex: "none", width: 8, fontWeight: 600, color: row.sign === " " ? color.inkMute : SIGN_INK[row.sign] }}>
                  {row.sign === " " ? "\u00a0" : row.sign}
                </span>
                {row.sign !== " " ? <span className="bk-sr-only">{row.sign === "-" ? "removed: " : "added: "}</span> : null}
                <LiteralText text={row.text} style={{ flex: 1, minWidth: 0, color: row.sign === " " ? color.inkMute : color.inkDim }} />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ── Affected messages ────────────────────────────────────────────────── */

/**
 * One affected message: its subject and sender when the host shows them, each
 * on its own line, then the date and labels as one meta line. A message the
 * card knows only by id (what today's payload carries) shows its id.
 */
function TargetRow({ target }: { target: GoogleMailTarget }) {
  const labels = target.labels ? shownLabels(target.labels).map((l) => l.text) : [];
  const meta: ReactNode[] = [];
  if (target.date) meta.push(<When key="date" date={target.date} style={{ font: `400 10.5px/1.5 ${font.mono}` }} />);
  if (labels.length > 0) meta.push(<bdi key="labels">{labels.join(", ")}</bdi>);
  if (!target.subject && !target.from && meta.length === 0) {
    return <span style={{ ...MONO, color: color.inkDim }} data-google-message-id="">{target.messageId}</span>;
  }
  return (
    <>
      {target.subject ? (
        <div style={{ fontWeight: 600 }}>
          <Field text={target.subject} />
        </div>
      ) : null}
      {target.from ? (
        <div style={{ color: color.inkDim, font: `400 11.5px/1.45 ${font.body}` }}>
          <Field text={target.from} />
        </div>
      ) : null}
      {meta.length > 0 ? (
        <div style={{ color: color.inkMute, font: `400 11.5px/1.5 ${font.body}` }} data-google-target-meta="">
          {meta.map((part, i) => (
            <span key={i}>
              {i > 0 ? <span aria-hidden="true">{"\u{a0}·\u{a0}"}</span> : null}
              {part}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * The affected messages: the first five, then "+N more", which expands the
 * whole list in place (at most 25, the call's cap) and moves focus to the
 * first row it revealed, so the reader carries on where the list grew.
 */
function Targets({ items }: { items: readonly GoogleMailTarget[] }) {
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const focusNext = useRef(false);
  const shown = all ? items : items.slice(0, FIRST);
  const rest = items.length - shown.length;
  useLayoutEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    list.current?.querySelectorAll<HTMLElement>("[data-google-target]")[FIRST]?.focus();
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <ul ref={list} className="bk-gma-targets" aria-label={`${messages(items.length)} affected`} data-google-targets="">
        {shown.map((target, i) => (
          <li key={`${target.messageId}-${i}`} className="bk-gma-target" tabIndex={-1} data-google-target={target.messageId}>
            <TargetRow target={target} />
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <button
          type="button"
          className="bk-text-btn"
          data-tone="inherit"
          aria-label={`Show ${plural(rest, "more message", "more messages")}`}
          onClick={() => {
            focusNext.current = true;
            setAll(true);
          }}
          style={{ alignSelf: "flex-start", font: `500 12px/20px ${font.body}`, color: color.inkDim, textDecoration: "none" }}
          data-google-targets-more=""
        >
          +{rest} more
        </button>
      ) : null}
    </div>
  );
}

function Delta({ line }: { line: DeltaLine }) {
  return (
    <p style={LINE} data-google-delta="">
      {line.before}
      {line.label ? (
        line.label.kind === "name" ? (
          <>
            “<bdi style={{ overflowWrap: "anywhere" }}>{line.label.text}</bdi>”
          </>
        ) : line.label.kind === "id" ? (
          <>
            label <span style={MONO}>{line.label.text}</span>
          </>
        ) : (
          line.label.text
        )
      ) : null}
      {line.after}
    </p>
  );
}

/* ── The card ─────────────────────────────────────────────────────────── */

interface Drawn {
  tool: string;
  icon: "mail" | "edit" | "trash";
  target: string;
  effect: GoogleEffect;
  send: boolean;
  allow: string;
  deny: string;
  risk: string;
  body: ReactNode;
  /** The standing choice's words when one may be offered: only ever on a reversible card. */
  standing: string | null;
}

const countTarget = (n: number, threads?: number | null) => `${messages(n)}${threads ? ` in ${plural(threads, "thread")}` : ""}`;

function draw(p: GoogleMailApprovalCardProps): Drawn {
  switch (p.operation) {
    case "gmail.draft.send":
      return {
        tool: "Send email",
        icon: "mail",
        target: `as ${spoken(p.sendAs.address)}${p.accountAlias ? ` (${p.accountAlias})` : ""}`,
        effect: "irreversible",
        send: true,
        allow: "Send email",
        deny: "Don't send",
        risk: "Sends email. It cannot be unsent.",
        body: (
          <>
            <Envelope message={p.message} sends matches={p.recipientMatches} sendAs={p.sendAs} thread={p.thread} threadId={p.threadId} replyRow />
            <ScrollBody body={p.message.body} caption="Brain's draft · not sent" />
          </>
        ),
        standing: null,
      };
    case "gmail.draft.save": {
      const words = p.action === "update"
        ? { tool: "Update draft", allow: "Update draft", deny: "Don't update" }
        : p.action === "reply"
          ? { tool: "Save draft reply", allow: "Save draft reply", deny: "Don't save" }
          : { tool: "Save draft", allow: "Save draft", deny: "Don't save" };
      return {
        ...words,
        icon: "edit",
        target: p.action === "update" && p.draftId ? `draft ${p.draftId}` : "in your drafts",
        effect: p.effect,
        send: false,
        risk: p.effect === "reversible" ? GOOGLE_REVERSIBLE_RISK : "Replaces the draft as it is now. Brain can't bring it back.",
        body: (
          <>
            <Envelope message={p.message} sends={false} thread={p.thread} threadId={p.threadId} replyRow={p.action === "reply"} />
            {p.action === "update" ? (
              <>
                <p style={{ ...LINE, color: color.inkDim }} data-google-replaces="">
                  {p.replacedAt ? <>Replaces the draft saved at <time title={p.replacedAt.full}>{p.replacedAt.short}</time>.</> : "Replaces the saved draft."}
                </p>
                {p.previousBody !== undefined && p.previousBody !== null ? <BodyChanges rows={bodyChanges(p.previousBody, p.message.body)} /> : null}
              </>
            ) : null}
            <ScrollBody body={p.message.body} caption="Brain's draft · not sent" />
          </>
        ),
        standing: standingLabel([{ kind: "drafts" }], p.tainted),
      };
    }
    case "gmail.draft.delete":
      return {
        tool: "Delete draft",
        icon: "trash",
        target: `draft ${p.draftId}`,
        effect: "irreversible",
        send: false,
        allow: "Delete draft",
        deny: "Keep draft",
        risk: "Deletes the draft. Brain can't bring it back.",
        body: p.message ? (
          <>
            <Envelope message={p.message} sends={false} threadId={null} replyRow={false} />
            <ClampedBody body={p.message.body} />
          </>
        ) : null,
        standing: null,
      };
    case "gmail.trash": {
      const n = p.messages.length;
      return {
        tool: "Move to Trash",
        icon: "trash",
        target: countTarget(n, p.threads),
        effect: "irreversible",
        send: false,
        allow: `Move ${n.toLocaleString("en-US")} to Trash`,
        deny: "Don't trash",
        risk: `Moves ${messages(n)} to Trash. Brain can't undo this yet.`,
        body: <Targets items={p.messages} />,
        standing: null,
      };
    }
    case "gmail.modify": {
      const n = p.messages.length;
      const actions = modifyActions(p.addLabels, p.removeLabels);
      return {
        ...modifyWords(actions, n),
        icon: "mail",
        target: countTarget(n, p.threads),
        effect: p.effect,
        send: false,
        risk: p.effect === "reversible" ? GOOGLE_REVERSIBLE_RISK : "Changes system labels. Brain can't undo this.",
        body: (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }} data-google-deltas="">
              {actions.map((action, i) => (
                <Delta key={i} line={deltaLine(action, n)} />
              ))}
            </div>
            <Targets items={p.messages} />
          </>
        ),
        standing: actions.length > 0 ? standingLabel(actions, p.tainted) : null,
      };
    }
  }
}

/** The standing choice the card may draw: the one its taint allows, only on a reversible card, only when offered. */
function standingOffer(p: GoogleMailApprovalCardProps, effect: GoogleEffect): (() => void) | undefined {
  if (effect !== "reversible") return undefined;
  const standing = p as Standing & Shared;
  const offered = standing.tainted ? standing.offers?.allowForSession : standing.offers?.allowAlways;
  return offered ? standing.onStanding : undefined;
}

export function GoogleMailApprovalCard(p: GoogleMailApprovalCardProps) {
  const d = draw(p);
  const onStanding = d.standing ? standingOffer(p, d.effect) : undefined;
  const glyph = d.effect === "reversible" ? "undo" : "failed";
  return (
    <div className="bk-gma" style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere" }} data-google-mail-approval={p.operation} data-effect={d.effect}>
      <ApprovalCard
        tool={d.tool}
        target={d.target}
        toolIcon={d.icon}
        badge={googleBadge(d.effect, d.send)}
        diff=""
        risk=""
        wrapHeader
        wrapActions
        allowLabel={d.allow}
        denyLabel={d.deny}
        allowEffect={d.effect}
        shortcuts={p.shortcuts ? googleApprovalKeys(d.effect) : undefined}
        onAllow={p.onAllow}
        onDeny={p.onDeny}
        top={p.tainted ? <TaintBanner /> : undefined}
        onAlwaysAllow={onStanding}
        alwaysLabel={d.standing ?? undefined}
        alwaysNote={onStanding ? (p.tainted ? GOOGLE_SESSION_NOTE : GOOGLE_ALWAYS_NOTE) : undefined}
      >
        <div className="bk-gma-frame">
          {d.body ? <div className="bk-gma-body">{d.body}</div> : null}
          <div style={RISK} data-google-risk="">
            <span style={{ display: "inline-flex", paddingTop: 2 }}>
              <Icon icon={glyph} size={12} color={accent.gold.ink} />
            </span>
            <span>{d.risk}</span>
          </div>
        </div>
      </ApprovalCard>
    </div>
  );
}
