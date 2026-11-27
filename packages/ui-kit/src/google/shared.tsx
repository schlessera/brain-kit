import { useLayoutEffect, useRef, type CSSProperties, type FocusEvent, type ReactNode, type RefObject } from "react";
import { Button } from "../primitives/Button.js";
import { Callout } from "../primitives/Callout.js";
import { Icon } from "../primitives/Icon.js";
import { Placeholder } from "../states/Placeholder.js";
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

/* ── Standing-permission lists (#4212) ──────────────────────────────────── */

/**
 * Shared parts of the two Gmail standing-permission lists (#4212):
 * `GoogleApprovalList` (Settings: remembered approvals) and
 * `GoogleAllowanceList` (a restricted chat's allowances). Presentational, props
 * and callbacks only; the host reads, revokes and formats every time.
 */

/** One standing Gmail change, in the entity vocabulary of
 * `gmailModifyActions` plus `drafts` for saving drafts. Irreversible
 * operations are never standing, so they have no kind here. */
export type GoogleStandingAction =
  | { kind: "archive" | "unarchive" | "mark_read" | "mark_unread" | "star" | "unstar" | "drafts" }
  | { kind: "label" | "unlabel"; labelId: string; labelName: string | null };

/** A time the host formatted. The kit never computes or formats a time. */
export interface GoogleHostTime {
  short: string;
  full: string;
}

const WORDS = {
  archive: "Archive",
  unarchive: "Move to inbox",
  mark_read: "Mark as read",
  mark_unread: "Mark as unread",
  star: "Star",
  unstar: "Remove star",
  drafts: "Save drafts",
} as const;

const LABEL_WORDS = { label: "Add label", unlabel: "Remove label" } as const;

/**
 * The words for one standing action. A label action names its label in curly
 * quotes when the host supplied the name: Add label “Voyage”. When the name
 * was withheld (`null`, or empty) the words stop at the verb and `mono`
 * carries the label id, drawn in mono and never quoted: "Add label `Label_7`".
 */
export function googleActionWords(action: GoogleStandingAction): { text: string; mono?: string } {
  if (action.kind === "label" || action.kind === "unlabel") {
    const verb = LABEL_WORDS[action.kind];
    return action.labelName ? { text: `${verb} “${action.labelName}”` } : { text: verb, mono: action.labelId };
  }
  return { text: WORDS[action.kind] };
}

/** The action as one plain string, for an accessible name. */
export function actionText(action: GoogleStandingAction): string {
  const words = googleActionWords(action);
  return words.mono ? `${words.text} ${words.mono}` : words.text;
}

/** "A", "A and B", "A, B and C". */
export function joinAnd(parts: readonly string[]): string {
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const MONO_ID: CSSProperties = { font: `500 11.5px/1.35 ${font.mono}`, overflowWrap: "anywhere" };

/**
 * The action as drawn. A label name is owner configuration the host escaped,
 * not sender text, so it is plain text, isolated in `<bdi>` so a
 * right-to-left name cannot reorder the words or the quotes around it, and it
 * wraps anywhere: Gmail allows a name of 225 code points, which the host's
 * escaping can stretch to 2,250 characters with no break opportunity.
 */
export function ActionWords({ action }: { action: GoogleStandingAction }) {
  const words = googleActionWords(action);
  if (words.mono !== undefined) {
    return (
      <>
        {words.text} <span style={MONO_ID} data-google-label-id="">{words.mono}</span>
      </>
    );
  }
  if (action.kind === "label" || action.kind === "unlabel") {
    return (
      <>
        {LABEL_WORDS[action.kind]} “<bdi style={{ overflowWrap: "anywhere" }}>{action.labelName}</bdi>”
      </>
    );
  }
  return <>{words.text}</>;
}

/* ── Paint shared by both lists ─────────────────────────────────────────── */

export const LIST_ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
};

/** The heading is focusable by script only (`tabIndex -1`): it is where focus
 * goes when a revoke removes the last row. No ring, as `EmptyState`'s title:
 * it is never a tab stop and never operable. */
export const HEADING: CSSProperties = { outline: "none" };

export const EXPLAINER: CSSProperties = { margin: 0, font: `400 12px/1.5 ${font.body}`, color: color.inkMute };

/** The owner's own account address: small mono, wrapping anywhere. */
export const ADDRESS: CSSProperties = {
  display: "block",
  font: `500 10.5px/1.4 ${font.mono}`,
  color: color.inkMute,
  overflowWrap: "anywhere",
};

export function titleStyle(dim: boolean): CSSProperties {
  return {
    display: "block",
    minWidth: 0,
    font: `600 12.5px/1.35 ${font.body}`,
    color: dim ? color.inkDim : color.ink,
    overflowWrap: "anywhere",
  };
}

/* ── Rows the host cannot show, and a read that failed ──────────────────── */

/**
 * How many rows the host holds but cannot show, read only in the ready
 * state. Any count above zero is at least one: a fractional or absurd count is
 * a host bug, and it must never turn into an empty claim.
 */
export function unshownCount(state: string, unshown: number | undefined): number {
  return state === "ready" && typeof unshown === "number" && unshown > 0 ? Math.ceil(unshown) : 0;
}

/** "1 remembered approval", "2 remembered approvals". */
export function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A CLI command inside notice text: mono, wrapping at its spaces. */
const COMMAND: CSSProperties = { font: `500 10.5px/1.5 ${font.mono}`, color: color.ink, overflowWrap: "anywhere" };

export function Command({ children }: { children: string }) {
  return <code style={COMMAND}>{children}</code>;
}

/**
 * Rows that exist but cannot be drawn here: a boxed amber notice with the
 * standing-permission key, saying how many and what still holds for them.
 * It replaces the list's empty line whenever its count is above zero, and it
 * is separate from the revoke-error banner: both can show at once.
 */
export function UnshownNotice({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div data-google-unshown={count}>
      <Callout tone="amber" variant="boxed" icon="capability">
        {children}
      </Callout>
    </div>
  );
}

/** The failed read's box: the error state, then Try again under it. */
const FAILED_BOX: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, minWidth: 0 };
/** Not failed: the box is empty and out of flow, so the list's gap does not count it. */
const FAILED_QUIET: CSSProperties = { position: "absolute", width: 0, height: 0, overflow: "hidden" };
const STATUS: CSSProperties = { alignSelf: "stretch", minWidth: 0 };

/**
 * A read that finished and failed: the kit's error state (red hairline, the
 * failure named, what it means underneath), never the loading ghost, which
 * says `aria-busy` while nothing is running, and never the empty line, which
 * would claim there is nothing. Try again shows only when the host listens,
 * as every kit retry does; it is a reaching `Button` as Live service settings'
 * Try again is, rather than `Placeholder`'s own pill, which paints under 24px
 * and has no coarse-pointer reach (#3252).
 *
 * The list draws this box in every state, so its `role="status"` region lives
 * as long as the list does, empty unless the read failed. Reaching the failed
 * state while the list is on screen (after Try again, or after a read the
 * host started) is then a change inside a region screen readers already
 * watch: they announce it once, politely, as Live service settings' persistent
 * status line is announced. The words are the ones drawn, not a hidden copy,
 * so browse mode reads them once. Loading draws its placeholder outside the
 * region, so nothing announces it; Try again sits outside it too.
 */
export function FailedRead({ failed, message, detail, onRetry }: { failed: boolean; message: string; detail: string; onRetry?: () => void }) {
  return (
    <div data-google-failed={failed ? "" : undefined} style={failed ? FAILED_BOX : FAILED_QUIET}>
      <div role="status" data-google-status="" style={STATUS}>
        {failed ? <Placeholder variant="error" message={message} detail={detail} /> : null}
      </div>
      {failed && onRetry ? <Button label="Try again" icon="retry" tone="ghost" size="sm" block={false} reach onClick={onRetry} /> : null}
    </div>
  );
}

/** Try again, found in the list it belongs to. */
const RETRY = "[data-google-failed] [role='button']";

/**
 * Try again leaves the failed state, and with it the button: when Try again
 * held focus as it was pressed, focus goes to the heading, the list's focus
 * target when nothing else is left to hold it. A retry fired while focus was
 * anywhere else (a script's click, say) moves nothing, and focus the user
 * moved elsewhere after pressing stays.
 */
export function useFocusAfterRetry(state: string, root: RefObject<HTMLElement | null>, heading: RefObject<HTMLElement | null>, onRetry?: () => void) {
  const pressed = useRef(false);
  useLayoutEffect(() => {
    if (state === "failed" || !pressed.current) return;
    pressed.current = false;
    const doc = root.current?.ownerDocument;
    if (!doc) return;
    const active = doc.activeElement;
    if (active && active !== doc.body && active.isConnected) return;
    heading.current?.focus();
  }, [state, root, heading]);
  if (!onRetry) return undefined;
  return () => {
    const retry = root.current?.querySelector(RETRY) ?? null;
    pressed.current = retry !== null && retry.ownerDocument.activeElement === retry;
    onRetry();
  };
}

/* ── Focus after a revoke ───────────────────────────────────────────────── */

/** Each focus target's host element carries this attribute with its id. The
 * host is the target itself when it is focusable (an approval row), or holds
 * it (an allowance row and its Revoke button). */
export const TARGET_ATTR = "data-google-target";

function targetOf(root: HTMLElement | null, id: string): HTMLElement | null {
  if (!root) return null;
  for (const host of root.querySelectorAll<HTMLElement>(`[${TARGET_ATTR}]`)) {
    if (host.getAttribute(TARGET_ATTR) !== id) continue;
    return host.hasAttribute("tabindex") ? host : host.querySelector<HTMLElement>("[tabindex]");
  }
  return null;
}

/** An element in `root`, read by shape rather than `instanceof`, which a
 * second realm (an iframe, a test DOM) would fail. */
function within(root: HTMLElement | null, node: EventTarget | null): Element | null {
  const el = node as Element | null;
  return root && el && typeof el.closest === "function" && root.contains(el) ? el : null;
}

function idOf(root: HTMLElement | null, node: EventTarget | null): string | null {
  return within(root, node)?.closest(`[${TARGET_ATTR}]`)?.getAttribute(TARGET_ATTR) ?? null;
}

/**
 * When a revoke removes the row that holds focus, focus goes to the next
 * surviving row's target; for the last row, the previous surviving one. When
 * no earlier row survives but the list still has rows (the host's response
 * replaced them), focus goes to the first row now shown. Only an empty list
 * sends focus to the heading. Focus that has left the list is never pulled
 * back.
 *
 * The list remembers which target last held focus. A blur whose element is
 * still in the document is the user moving away, so it forgets; a blur fired
 * by the removal itself (browsers differ on whether one fires) is not, so the
 * id survives until the render that dropped the row. After that render, focus
 * moves only if nothing else holds it.
 */
export function useFocusAfterRemoval(
  ids: readonly string[],
  root: RefObject<HTMLElement | null>,
  heading: RefObject<HTMLElement | null>,
) {
  const focused = useRef<string | null>(null);
  const previous = useRef<readonly string[]>(ids);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = ids;
    const id = focused.current;
    if (id === null || ids.includes(id)) return;
    focused.current = null;
    // The list's own document, not this module's: a list rendered into
    // another document (a same-origin frame) must read that frame's focus.
    const doc = root.current?.ownerDocument;
    if (!doc) return;
    const active = doc.activeElement;
    if (active && active !== doc.body && active.isConnected) return;
    const at = before.indexOf(id);
    const next =
      before.slice(at + 1).find((other) => ids.includes(other)) ??
      before.slice(0, Math.max(0, at)).reverse().find((other) => ids.includes(other)) ??
      ids[0];
    const target = next === undefined ? heading.current : targetOf(root.current, next);
    target?.focus();
  });

  return {
    onFocus(event: FocusEvent<HTMLElement>) {
      focused.current = idOf(root.current, event.target);
    },
    onBlur(event: FocusEvent<HTMLElement>) {
      if (within(root.current, event.relatedTarget)) return;
      const left = event.target;
      const id = focused.current;
      queueMicrotask(() => {
        if (left.isConnected && focused.current === id) focused.current = null;
      });
    },
  };
}
