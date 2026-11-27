import { useLayoutEffect, useRef, type CSSProperties, type FocusEvent, type ReactNode, type RefObject } from "react";

import { Button } from "../primitives/Button.js";
import { Callout } from "../primitives/Callout.js";
import { Placeholder } from "../states/Placeholder.js";
import { color, font } from "../tokens.js";

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

/**
 * A read that finished and failed: the kit's error state (red hairline, the
 * failure named, what it means underneath), never the loading ghost, which
 * says `aria-busy` while nothing is running, and never the empty line, which
 * would claim there is nothing. Try again shows only when the host listens,
 * as every kit retry does; it is a reaching `Button` as Live service settings'
 * Try again is, rather than `Placeholder`'s own pill, which paints under 24px
 * and has no coarse-pointer reach (#3252).
 */
export function FailedRead({ message, detail, onRetry }: { message: string; detail: string; onRetry?: () => void }) {
  return (
    <div data-google-failed="" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
      <Placeholder variant="error" message={message} detail={detail} />
      {onRetry ? <Button label="Try again" icon="retry" tone="ghost" size="sm" block={false} reach onClick={onRetry} /> : null}
    </div>
  );
}

/**
 * Try again leaves the failed state, and with it the button: when the press
 * took focus with it, focus goes to the heading, the list's focus target when
 * nothing else is left to hold it. Focus the user moved elsewhere stays.
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
    pressed.current = true;
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
