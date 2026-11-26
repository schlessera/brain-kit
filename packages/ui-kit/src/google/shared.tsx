import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import { invisibleSegments, revealInvisibles } from "./reveal-invisibles.js";

/**
 * Shared pieces of the Gmail components (#4209, epic #4201; design brief of
 * 2026-11-20 and maintainer rulings G1–G5).
 *
 * The family is presentational: props and callbacks only, no client, no
 * fetch, no store. ui-react maps the `@schlessera/brain-ui-sdk` Gmail
 * payloads (`tool-contracts/google.ts`) onto these props (#4210): the field
 * names are the payload's in camelCase, a timestamp arrives formatted
 * (`GmailDate`; the kit never computes a time), and everything a third party
 * wrote sits under `untrusted`, exactly where the payload puts it.
 *
 * Two views. A `structured` item has no slot for a sender, a subject or any
 * other text a stranger wrote: its type cannot carry one, so no structured
 * row can show one. A `content` item adds `untrusted`, and every string in
 * it is revealed (`revealInvisibles`) and shown through `Field` or
 * `UntrustedText`, never as markup.
 */

/** A Gmail label as the payload carries it: Google's id and, for a user label, the owner's escaped name. */
export interface GmailLabel {
  id: string;
  name: string | null;
}

/** How big a message or thread is, as the payload's closed buckets say. */
export type GmailSizeBucket = "under_10kb" | "under_100kb" | "under_1mb" | "1mb_or_more";

/** A Gmail timestamp the host formatted. The kit never computes a time. */
export interface GmailDate {
  /** What the row shows: "Sat 11 Jul 18:02". */
  short: string;
  /** What a screen reader hears: "Saturday 11 July 2026, 18:02". */
  full: string;
  /** The RFC 3339 instant, for `<time dateTime>`. */
  iso?: string;
}

/** The flags both views carry. `null` or absent: the payload did not say, which is not `false`. */
export interface GmailFlags {
  unread?: boolean | null;
  starred?: boolean | null;
  hasAttachment?: boolean | null;
}

/** System labels as the words Gmail shows for them (ruling G5). */
const SYSTEM_WORDS: Record<string, string> = {
  INBOX: "Inbox",
  IMPORTANT: "Important",
  SENT: "Sent",
  DRAFT: "Draft",
  SPAM: "Spam",
  TRASH: "Trash",
  CHAT: "Chat",
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

/**
 * Labels the row already says as a flag (ruling G5): UNREAD and STARRED, and
 * the coloured "superstars" Gmail adds beside STARRED, whose only meaning is
 * a colour the kit does not carry.
 */
const AS_FLAGS = /^(UNREAD|STARRED|(YELLOW|ORANGE|RED|PURPLE|BLUE|GREEN)_(STAR|BANG|GUILLEMET|CHECK|INFO|QUESTION|CIRCLE))$/;

/** One label as a reader sees it. */
interface ShownLabel {
  id: string;
  /** "Inbox", or the owner's label name. */
  text: string;
  /** A user label whose name the payload withheld: its id is shown, in mono. */
  idOnly: boolean;
}

/**
 * The labels a row shows, in order: system labels as words first, then the
 * owner's labels in the payload's order. UNREAD, STARRED and the superstars
 * are flags, not labels.
 */
export function shownLabels(labels: readonly GmailLabel[]): ShownLabel[] {
  const system: ShownLabel[] = [];
  const user: ShownLabel[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.id) || AS_FLAGS.test(label.id)) continue;
    seen.add(label.id);
    const word = SYSTEM_WORDS[label.id];
    if (word) system.push({ id: label.id, text: word, idOnly: false });
    else if (/^[A-Z][A-Z0-9_]*$/.test(label.id)) continue; // a system label the kit has no word for
    else user.push({ id: label.id, text: label.name ?? label.id, idOnly: label.name === null });
  }
  return [...system, ...user];
}

/** Every label across several messages, once each, in first-seen order. */
export function mergeLabels(lists: readonly (readonly GmailLabel[])[]): GmailLabel[] {
  const out: GmailLabel[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const label of list) {
      if (seen.has(label.id)) continue;
      seen.add(label.id);
      out.push(label);
    }
  }
  return out;
}

const SIZE_WORDS: Record<GmailSizeBucket, string> = {
  under_10kb: "under 10 KB",
  under_100kb: "under 100 KB",
  under_1mb: "under 1 MB",
  "1mb_or_more": "1 MB or more",
};

const sizeWords = (bucket: GmailSizeBucket) => SIZE_WORDS[bucket];

/** "3,412". */
export const count = (n: number) => n.toLocaleString("en-US");

/** "1 message", "3 messages". */
export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** An attachment's size in bytes, as a reader reads it: "860 bytes", "120 KB", "2.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return plural(bytes, "byte");
  if (bytes < 1024 * 1024) return `${count(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Mono caps label over a fact. */
export const CAPS: CSSProperties = {
  font: `500 9px/1.4 ${font.mono}`,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: color.inkMute,
};

/** Mono meta text: dates, counts, sizes. */
export const META: CSSProperties = {
  font: `400 10.5px/1.5 ${font.mono}`,
  color: color.inkMute,
};

/** The content view's provenance line: the purple of `UntrustedText`'s caption. */
export const PROVENANCE: CSSProperties = {
  font: `500 9.5px/1.4 ${font.mono}`,
  color: accent.purple.ink,
};

/** Ruling G1, verbatim: the one line that says what a structured list holds. */
export const STRUCTURED_LINE = "Structured view · dates, labels and counts only. Brain didn't read these messages.";
/** The same line for one message. */
export const STRUCTURED_LINE_ONE = "Structured view · dates, labels and counts only. Brain didn't read this message.";
/** The content view's line. */
export const CONTENT_LINE = "Content view · written by others · not checked";

/** What the interstitial says a link in mail was written in. The sender is a header anyone can write, so it names no author. */
export const MAIL_SOURCE = { source: "Gmail", sourcePhrase: "in this email", author: null, caption: false as const };

/**
 * An untrusted single-line field (sender, subject, address, file name):
 * bidi-isolated, wraps anywhere, and every hidden character shown as a small
 * mono marker that a screen reader names (ruling G4).
 */
export function Field({ text, style, className }: { text: string; style?: CSSProperties; className?: string }) {
  return (
    <bdi style={{ overflowWrap: "anywhere", ...style }} className={className} data-untrusted-field="">
      <Revealed text={text} />
    </bdi>
  );
}

/** Text with each hidden character drawn as its marker chip. */
function Revealed({ text }: { text: string }) {
  const segments = invisibleSegments(text);
  if (segments.length === 1 && segments[0]!.kind === "text") return <>{text}</>;
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === "text" ? (
          <bdi key={i}>{segment.text}</bdi>
        ) : (
          <span key={i} className="bk-gm-hidden" data-hidden-char={segment.marker}>
            <span aria-hidden="true">{segment.marker}</span>
            <span className="bk-sr-only">{` ${segment.spoken} `}</span>
          </span>
        ),
      )}
    </>
  );
}

/** An untrusted string for a plain-text slot (a body `UntrustedText` draws), with each hidden character as its `‹U+XXXX›` marker. */
export const spoken = (text: string) => revealInvisibles(text);

/**
 * An untrusted string for an accessible name: each hidden character said as
 * `Field` says it to a screen reader ("hidden character: right-to-left
 * override"), never as its hex marker, which a screen reader would spell out.
 */
export function accessibleName(text: string): string {
  let out = "";
  for (const segment of invisibleSegments(text)) out += segment.kind === "text" ? segment.text : ` ${segment.spoken} `;
  return out.replace(/ {2,}/g, " ").replace(/^ +| +$/g, "");
}

/** The flags line: glyph and word, never colour alone. Renders nothing when the payload carries none. */
export function Flags({ flags, size, attachments, style }: { flags: GmailFlags; size?: GmailSizeBucket | null; attachments?: number | null; style?: CSSProperties }) {
  const parts: ReactNode[] = [];
  if (flags.unread) parts.push(<span key="unread">unread</span>);
  if (flags.starred) parts.push(<span key="starred" className="bk-gm-flag"><Icon icon="star" size={11} />starred</span>);
  if (attachments !== undefined && attachments !== null && attachments > 0) {
    parts.push(<span key="attach" className="bk-gm-flag"><Icon icon="attach" size={11} />{plural(attachments, "attachment")}</span>);
  } else if (flags.hasAttachment) {
    parts.push(<span key="attach" className="bk-gm-flag"><Icon icon="attach" size={11} />attachment</span>);
  }
  if (size) parts.push(<span key="size">{sizeWords(size)}</span>);
  if (parts.length === 0) return null;
  return (
    <span style={{ ...META, ...style }} className="bk-gm-flags" data-gmail-flags="">
      {parts.map((part, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
          {i > 0 ? <span aria-hidden="true">{"\u{a0}·\u{a0}"}</span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

/** The unread dot: a mark beside a bold date or name. The word "unread" says it too. */
export function UnreadDot({ unread }: { unread?: boolean | null }) {
  return <span aria-hidden="true" className="bk-gm-dot" data-unread={unread ? "" : undefined} />;
}

/** A date the host formatted, as a `<time>`. */
export function When({ date, style }: { date: GmailDate; style?: CSSProperties }) {
  return (
    <time dateTime={date.iso} style={style}>
      {date.short}
    </time>
  );
}
