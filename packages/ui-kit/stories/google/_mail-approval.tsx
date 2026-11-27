// Shared furniture for the Gmail approval card stories (#4215): the host's
// single-key binding as #4216 will wire it, the two widths, and the checks
// every story's play runs on the card it drew, at its width, in its theme.

import type { KeyboardEvent } from "react";
import { expect } from "storybook/test";

import { GoogleMailApprovalCard, googleApprovalKeys, type GoogleMailApprovalCardProps } from "../../src/index.js";
import { containment, escapes, narrow as gmailNarrow, smallTargets, targets } from "./_gmail.js";

export { desktop, widthOf } from "./_gmail.js";

/** A phone: the 320px viewport, where no single key is printed (a coarse pointer). */
export const narrow = { ...gmailNarrow, args: { shortcuts: false } };

/** The card's effect, as the host knows it from the card: send, delete and trash are always irreversible. */
export const effectOf = (p: GoogleMailApprovalCardProps) => (p.operation === "gmail.modify" || p.operation === "gmail.draft.save" ? p.effect : "irreversible");

/**
 * The card as ui-react will host it (#4216): a focusable approval group that
 * answers to exactly the keys `googleApprovalKeys` gives for the card's
 * effect, the same keys the card prints. An irreversible card has no allow
 * key, so `a` does nothing; `d` denies.
 */
export function Hosted(props: GoogleMailApprovalCardProps) {
  const keys = googleApprovalKeys(effectOf(props));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    if (keys.allow !== undefined && event.key === keys.allow) {
      event.preventDefault();
      props.onAllow?.();
    } else if (event.key === keys.deny) {
      event.preventDefault();
      props.onDeny?.();
    }
  };
  return (
    <div role="group" aria-label="Approval" tabIndex={0} onKeyDown={onKeyDown} data-approval-host="" style={{ width: "100%", minWidth: 0, borderRadius: 14, outlineOffset: 2 }}>
      <GoogleMailApprovalCard {...props} />
    </div>
  );
}

/** The card the story drew. */
export function cardIn(canvasElement: HTMLElement): HTMLElement {
  const card = canvasElement.querySelector<HTMLElement>("[data-google-mail-approval]");
  if (!card) throw new Error("the story drew no mail approval card");
  return card;
}

/** Each decision button's printed label, without its effect chip. */
export const printed = (card: HTMLElement) =>
  [...card.querySelectorAll<HTMLElement>("[data-kit-approval-actions] [data-bk-button]")].map((b) => b.querySelector("span")?.textContent ?? "");

/**
 * What every story asserts, at its width and in its theme: the card drew at
 * that width, nothing escapes it, every control is a full target (a 24px box
 * with a 44px touch reach), and the untrusted strings the story names are on
 * screen inside a field or a text block and nowhere else.
 */
export async function holds(canvasElement: HTMLElement, width: "narrow" | "desktop", untrusted: string[] = []) {
  const card = cardIn(canvasElement);
  if (width === "narrow") {
    await expect(window.innerWidth, "the phone story runs at the 320px viewport").toBe(320);
    await expect(card.getBoundingClientRect().width, "the card fills the phone").toBeGreaterThan(280);
  } else {
    const column = canvasElement.firstElementChild as HTMLElement;
    await expect(column.getBoundingClientRect().width, "the desktop story draws in the 680px column").toBe(680);
    await expect(card.getBoundingClientRect().width, "the card fills its column").toBe(680);
  }
  await expect(escapes(card), "nothing escapes the card").toEqual([]);
  await expect(targets(card).length, "Allow and Deny are there to measure").toBeGreaterThanOrEqual(2);
  await expect(smallTargets(card), "every control is a 24px box with a 44px touch reach, both ways").toEqual([]);
  await expect(containment(card, untrusted), "untrusted text is on screen, and only inside a field or text block").toEqual({ unguarded: [], guarded: untrusted });
}

/** A node's text as drawn: text as written, each hidden-character chip as the marker it shows (never its `data-hidden-char`), gutter numbers and screen-reader words left out. */
export function drawnText(el: Element): string {
  let out = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue ?? "";
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const e = child as Element;
    if (e.hasAttribute("data-line-number") || e.classList.contains("bk-sr-only")) continue;
    out += drawnText(e);
  }
  return out;
}

/** A body's drawn lines, as text: what the recipient gets, hidden characters as their markers. */
export const drawnLines = (container: Element) => [...container.querySelectorAll("[data-google-body-line]")].map(drawnText);

/** The whole body as drawn, its lines joined by "\n". */
export const drawnBody = (container: Element) => drawnLines(container).join("\n");

/** One change row's line, as drawn. */
export const drawnRow = (row: Element) => drawnText(row.querySelector("[data-untrusted-field]")!);

/** What only Markdown would draw: none of it belongs in a plain-text body. */
export const MARKUP = "strong, em, del, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, li, code, pre, a, button, img, [data-untrusted-link]";

/** No standing choice of any kind: the element is not drawn, and neither are its words. */
export async function noStandingChoice(card: HTMLElement) {
  await expect(card.querySelector("[data-kit-approval-actions]"), "the decision row is drawn").not.toBeNull();
  await expect(card.querySelectorAll("[data-kit-approval-always]"), "no standing choice on an irreversible card").toHaveLength(0);
  await expect(card.textContent ?? "").not.toMatch(/Always allow|for this chat/);
}
