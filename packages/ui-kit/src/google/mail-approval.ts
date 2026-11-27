/**
 * The words and the arithmetic of the Gmail approval cards (#4215, epic
 * #4201; design brief of 2026-11-20, rulings of 2026-11-24 M1–M6). Pure: no
 * DOM, no React, no time. `GoogleMailApprovalCard` draws what this returns.
 *
 * The approved copy is quoted verbatim from the brief (M5): the taint banner,
 * the standing choices and their notes, the risk lines and the verb-object
 * Allow and Deny labels. Where the brief named an example and left the rest
 * of a family open (the modify verbs, an irreversible modify or draft
 * save), the words follow the same pattern and are listed in the design
 * record for sign-off (M7).
 */
import { invisibleSegments } from "./reveal-invisibles.js";
import { joinAnd, type GmailLabel } from "./shared.js";

/* ── Effect, keys and the approved copy ───────────────────────────────── */

/** What an allow changes: only the owner's mailbox, with a recorded inverse, or something Brain cannot take back. */
export type GoogleEffect = "reversible" | "irreversible";

/**
 * The single keys a Google card answers to, printed and bound alike (M4).
 * An irreversible card has no allow key at all: `a` is neither printed nor
 * bound, so a stray key press can never send, delete or trash. `d` stays.
 * A reversible card keeps both.
 */
export function googleApprovalKeys(effect: GoogleEffect): { allow?: "a"; deny: "d" } {
  return effect === "reversible" ? { allow: "a", deny: "d" } : { deny: "d" };
}

/**
 * The refusal sentence for a send the host refused because a recipient is
 * not on the send list (M6). The host refuses before any card, so this is the
 * tool row's error text (#4216), never card state. It names no address: the
 * address is text the sender controls.
 */
export const GOOGLE_SEND_RECIPIENT_REFUSAL = "Not sent: one recipient isn't on your send list.";

/** The taint banner (M5), on every Google card in a tainted chat. */
export const GOOGLE_TAINT_BANNER = "This chat has read mail or events written by other people. Check this is something you asked for.";

/** The standing choice's note (M5): untainted, then tainted. */
export const GOOGLE_ALWAYS_NOTE = "Saved to your Google approvals. Revoke in Settings.";
export const GOOGLE_SESSION_NOTE = "This chat has read others' mail, so this lasts only here: up to 24 hours or 100 messages.";

/** The reversible risk line (M5). */
export const GOOGLE_REVERSIBLE_RISK = "Changes only your mailbox. Brain records how to reverse it.";

/** "1 message", "12 messages". */
export const messages = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "message" : "messages"}`;

/** The badge in the card's head: words, never colour alone. */
export function googleBadge(effect: GoogleEffect, send: boolean): string {
  if (effect === "reversible") return "Only your mailbox";
  return send ? "Can't be unsent" : "Can't be undone";
}

/* ── Modify: the label delta in words ─────────────────────────────────── */

/** System labels a delta names, as Gmail shows them. Ids the kit has no word for are drawn in mono. */
const SYSTEM_WORDS: Record<string, string> = {
  INBOX: "Inbox",
  IMPORTANT: "Important",
  SPAM: "Spam",
  TRASH: "Trash",
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

const SYSTEM_ID = /^[A-Z][A-Z0-9_]*$/;

/**
 * One label as a delta names it: a system label by its word ("Inbox"), an
 * owner's label by its name in curly quotes (“Voyage”, as `googleActionWords`
 * sets it), and a label whose name the host withheld, or a system label with
 * no word, by its id in mono.
 */
type LabelWords = { kind: "word"; text: string } | { kind: "name"; text: string } | { kind: "id"; text: string };

function labelWords(label: GmailLabel): LabelWords {
  const system = SYSTEM_WORDS[label.id];
  if (system) return { kind: "word", text: system };
  if (SYSTEM_ID.test(label.id) || !label.name) return { kind: "id", text: label.id };
  return { kind: "name", text: label.name };
}

/** The label as plain text, for an accessible name or a summary under test. */
const labelText = (words: LabelWords) => (words.kind === "name" ? `“${words.text}”` : words.kind === "id" ? `label ${words.text}` : words.text);

/** One line of a modify's summary: a sentence with an optional label in it. */
export interface DeltaLine {
  /** Before the label, or the whole sentence when there is none. */
  before: string;
  label?: LabelWords;
  after?: string;
}

/** The standing-action kinds a modify can ask for, as `gmailModifyActions` names them. */
type ModifyAction =
  | { kind: "archive" | "unarchive" | "mark_read" | "mark_unread" | "star" | "unstar" }
  | { kind: "label" | "unlabel"; label: GmailLabel }
  /** A system label beyond INBOX, UNREAD and STARRED: what escalates a modify to irreversible. */
  | { kind: "system"; label: GmailLabel; add: boolean };

/** The actions a modify takes, in the order its summary says them: removals first, as archive reads. */
export function modifyActions(add: readonly GmailLabel[], remove: readonly GmailLabel[]): ModifyAction[] {
  const out: ModifyAction[] = [];
  const seen = new Set<string>();
  const push = (key: string, action: ModifyAction) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(action);
  };
  for (const label of remove) {
    if (label.id === "INBOX") push("archive", { kind: "archive" });
    else if (label.id === "UNREAD") push("mark_read", { kind: "mark_read" });
    else if (label.id === "STARRED") push("unstar", { kind: "unstar" });
    else if (SYSTEM_ID.test(label.id)) push(`-${label.id}`, { kind: "system", label, add: false });
    else push(`unlabel:${label.id}`, { kind: "unlabel", label });
  }
  for (const label of add) {
    if (label.id === "INBOX") push("unarchive", { kind: "unarchive" });
    else if (label.id === "UNREAD") push("mark_unread", { kind: "mark_unread" });
    else if (label.id === "STARRED") push("star", { kind: "star" });
    else if (SYSTEM_ID.test(label.id)) push(`+${label.id}`, { kind: "system", label, add: true });
    else push(`label:${label.id}`, { kind: "label", label });
  }
  return out;
}

/** One summary line per action: "Removes Inbox from 12 messages." (M5's example), "Marks 7 messages read.", "Adds “Voyage” to 4 messages." */
export function deltaLine(action: ModifyAction, n: number): DeltaLine {
  const m = messages(n);
  switch (action.kind) {
    case "archive": return { before: "Removes ", label: { kind: "word", text: "Inbox" }, after: ` from ${m}.` };
    case "unarchive": return { before: "Adds ", label: { kind: "word", text: "Inbox" }, after: ` to ${m}.` };
    case "mark_read": return { before: `Marks ${m} read.` };
    case "mark_unread": return { before: `Marks ${m} unread.` };
    case "star": return { before: `Stars ${m}.` };
    case "unstar": return { before: `Removes the star from ${m}.` };
    case "label": return { before: "Adds ", label: labelWords(action.label), after: ` to ${m}.` };
    case "unlabel": return { before: "Removes ", label: labelWords(action.label), after: ` from ${m}.` };
    case "system": return action.add
      ? { before: "Adds ", label: labelWords(action.label), after: ` to ${m}.` }
      : { before: "Removes ", label: labelWords(action.label), after: ` from ${m}.` };
  }
}

/** The line as plain text. */
export const deltaText = (line: DeltaLine) => `${line.before}${line.label ? labelText(line.label) : ""}${line.after ?? ""}`;

/** The head, Allow and Deny words of a modify: one verb for one action, "Change labels" for several. */
export function modifyWords(actions: readonly ModifyAction[], n: number): { tool: string; allow: string; deny: string } {
  const count = n.toLocaleString("en-US");
  const only = actions.length === 1 ? actions[0]! : null;
  switch (only?.kind) {
    case "archive": return { tool: "Archive", allow: `Archive ${count}`, deny: "Don't archive" };
    case "unarchive": return { tool: "Move to Inbox", allow: `Move ${count} to Inbox`, deny: "Don't move" };
    case "mark_read": return { tool: "Mark read", allow: `Mark ${count} read`, deny: "Don't mark" };
    case "mark_unread": return { tool: "Mark unread", allow: `Mark ${count} unread`, deny: "Don't mark" };
    case "star": return { tool: "Star", allow: `Star ${count}`, deny: "Don't star" };
    case "unstar": return { tool: "Remove star", allow: `Unstar ${count}`, deny: "Don't unstar" };
    case "label": return { tool: "Add label", allow: `Label ${count}`, deny: "Don't label" };
    case "unlabel": return { tool: "Remove label", allow: `Unlabel ${count}`, deny: "Don't unlabel" };
    default: return { tool: "Change labels", allow: `Change ${count}`, deny: "Don't change" };
  }
}

/* ── The standing choice (reversible cards only) ──────────────────────── */

/** The gerund a standing choice names its entity with: `archive` → "archiving" (M5). */
function gerund(action: ModifyAction | { kind: "drafts" }): string {
  switch (action.kind) {
    case "archive": return "archiving";
    case "unarchive": return "moving to Inbox";
    case "mark_read": return "marking read";
    case "mark_unread": return "marking unread";
    case "star": return "starring";
    case "unstar": return "removing stars";
    case "drafts": return "saving drafts";
    case "label": return `adding ${labelText(labelWords(action.label))}`;
    case "unlabel": return `removing ${labelText(labelWords(action.label))}`;
    // An irreversible action is never standing; the words exist only so the switch is total.
    case "system": return `changing ${labelText(labelWords(action.label))}`;
  }
}

/**
 * The standing choice's button: "Always allow archiving" in an untainted
 * chat, "Allow archiving for this chat" in a tainted one (M5). Several
 * actions are joined: "Always allow archiving and marking read".
 */
export function standingLabel(actions: readonly (ModifyAction | { kind: "drafts" })[], tainted: boolean): string {
  const what = joinAnd(actions.map(gerund));
  return tainted ? `Allow ${what} for this chat` : `Always allow ${what}`;
}

/* ── The envelope ─────────────────────────────────────────────────────── */

interface Mailbox {
  address: string;
  displayName: string | null;
}

/** "To 1 · Cc 1 · Bcc 1 — 3 people get this". Bcc is counted before any address is shown (M2). A draft that is not sent says only the counts. */
export function envelopeSummary(env: { to: readonly Mailbox[]; cc: readonly Mailbox[]; bcc: readonly Mailbox[] }, sends: boolean): string {
  const counts = `To ${env.to.length} · Cc ${env.cc.length} · Bcc ${env.bcc.length}`;
  if (!sends) return counts;
  const people = new Set([...env.to, ...env.cc, ...env.bcc].map((m) => m.address.toLowerCase())).size;
  return `${counts} — ${people === 1 ? "1 person gets this" : `${people.toLocaleString("en-US")} people get this`}`;
}

/** Whether any Reply-To address differs from From: then replies go elsewhere, and the card says so. */
export const repliesElsewhere = (from: Mailbox, replyTo: readonly Mailbox[]) =>
  replyTo.some((m) => m.address.toLowerCase() !== from.address.toLowerCase());

/** How many hidden characters `text` holds, counting each one in a run. */
function hiddenCount(text: string): number {
  let n = 0;
  for (const segment of invisibleSegments(text)) if (segment.kind === "hidden") n += segment.count;
  return n;
}

/** "1 hidden character", "3 hidden characters". */
const hiddenWords = (n: number) => `${n.toLocaleString("en-US")} hidden ${n === 1 ? "character" : "characters"}`;

/**
 * The line under the envelope when any shown value held a hidden character
 * (brief §7): "2 hidden characters in Subject and To are shown as ‹U+…›."
 * `fields` lists each field with its text, in envelope order; `null` when
 * nothing was hidden.
 */
export function hiddenSummary(fields: readonly [field: string, texts: readonly (string | null | undefined)[]][]): string | null {
  let total = 0;
  const named: string[] = [];
  for (const [field, texts] of fields) {
    const n = texts.reduce((sum, text) => sum + (text ? hiddenCount(text) : 0), 0);
    if (n === 0) continue;
    total += n;
    named.push(field);
  }
  if (total === 0) return null;
  return `${hiddenWords(total)} in ${joinAnd(named)} ${total === 1 ? "is" : "are"} shown as ‹U+…›.`;
}

/* ── The body ─────────────────────────────────────────────────────────── */

/** How many lines a body has, as its text spells them: "a\nb" is two. */
export const lineCount = (body: string) => (body === "" ? 0 : body.replace(/\r\n?/g, "\n").split("\n").length);

/** A body's size in UTF-8 bytes, as a reader reads it: "860 bytes", "2.1 KB". */
export function bodySize(body: string): string {
  const bytes = new TextEncoder().encode(body).length;
  if (bytes < 1024) return `${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"}`;
  return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
}

/** "Body · 41 lines · 2.1 KB · plain text", and "· 1 hidden character" when the body has one. */
export function bodyHeader(body: string): string {
  const lines = lineCount(body);
  const hidden = hiddenCount(body);
  return [`Body · ${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}`, bodySize(body), "plain text", ...(hidden > 0 ? [hiddenWords(hidden)] : [])].join(" · ");
}

/** The scroll region's name: "Message body, 41 lines". */
export const bodyRegionName = (body: string) => {
  const lines = lineCount(body);
  return `Message body, ${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}`;
};

/**
 * How many of the body's lines are below the visible part of its scroll
 * region: the line count scaled by the share of the region's content that
 * is below the fold, rounded up, so anything left unread counts as at least
 * one line. Zero once the end is in view. The share is of rendered height,
 * not of source lines, so the cue is an estimate in the body's own unit
 * and can never exceed its line count.
 */
export function linesBelow(total: number, scrollHeight: number, scrollTop: number, clientHeight: number): number {
  if (total <= 0 || scrollHeight <= 0) return 0;
  const below = scrollHeight - scrollTop - clientHeight;
  if (below <= 1) return 0;
  return Math.min(total, Math.max(1, Math.ceil((total * below) / scrollHeight)));
}

/** "↓ 23 more lines". */
export const moreLines = (n: number) => `↓ ${n.toLocaleString("en-US")} more ${n === 1 ? "line" : "lines"}`;

/* ── A draft update's body change ─────────────────────────────────────── */

/** One row of a body change: a removed, added or unchanged line, or a run of unchanged lines left out. */
export type ChangeRow =
  | { sign: "-" | "+" | " "; text: string }
  | { sign: "…"; count: number };

/** The most cells the line comparison fills before it stops looking for a smaller change. */
const MAX_CELLS = 1_000_000;

/**
 * The line-by-line change from `before` to `after`, with one unchanged line of
 * context around each change and every longer unchanged run counted instead
 * of shown. The shared head and tail are trimmed first; the middle is
 * compared by longest common subsequence while it fits `MAX_CELLS`, and past
 * that shown whole as removed then added, which is still exact, only not
 * the smallest. `[]` when nothing changed.
 */
export function bodyChanges(before: string, after: string, context = 1): ChangeRow[] {
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) return [];

  const middle: { sign: "-" | "+" | " "; text: string }[] = [];
  if (midA.length * midB.length <= MAX_CELLS && midA.length > 0 && midB.length > 0) {
    // lcs[i][j]: the longest common subsequence of midA[i..] and midB[j..], one flat array.
    const w = midB.length + 1;
    const lcs = new Uint32Array((midA.length + 1) * w);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        middle.push({ sign: " ", text: midA[i]! });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        middle.push({ sign: "-", text: midA[i++]! });
      } else {
        middle.push({ sign: "+", text: midB[j++]! });
      }
    }
    while (i < midA.length) middle.push({ sign: "-", text: midA[i++]! });
    while (j < midB.length) middle.push({ sign: "+", text: midB[j++]! });
  } else {
    for (const text of midA) middle.push({ sign: "-", text });
    for (const text of midB) middle.push({ sign: "+", text });
  }

  const all = [...a.slice(0, head).map((text) => ({ sign: " " as const, text })), ...middle, ...a.slice(a.length - tail).map((text) => ({ sign: " " as const, text }))];
  const near = all.map(() => false);
  all.forEach((row, k) => {
    if (row.sign === " ") return;
    for (let d = -context; d <= context; d++) if (k + d >= 0 && k + d < all.length) near[k + d] = true;
  });
  const out: ChangeRow[] = [];
  let skipped = 0;
  all.forEach((row, k) => {
    if (near[k]) {
      if (skipped > 0) out.push({ sign: "…", count: skipped });
      skipped = 0;
      out.push(row);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ sign: "…", count: skipped });
  return out;
}

/** "3 unchanged lines". */
export const unchangedLines = (n: number) => `${n.toLocaleString("en-US")} unchanged ${n === 1 ? "line" : "lines"}`;
