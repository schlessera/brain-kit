// Shared furniture for the Gmail standing-permission stories (#4212): the
// Odysseus fixtures, the two widths every state is drawn at, and the checks
// every story's play runs on the rendered list.

import type { Decorator } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import type { GoogleAllowanceListProps, GoogleApprovalListProps, GoogleHostTime, GoogleStandingAction } from "../../src/index.js";
import { accent } from "../../src/tokens.js";
import { viewportAt } from "../_viewports.js";

/* ── Widths ───────────────────────────────────────────────────────────── */

/**
 * The list is drawn in a column of exactly its story's width, not at most it,
 * so "drew at its width" is a measurement that can fail: a list that collapses
 * or a row that pushes it wider shows up as a number, whatever the runner's
 * own viewport.
 */
export const column: Decorator = (Story, context) => (
  <div data-google-column="" style={{ width: (context.parameters.googleWidth as number | undefined) ?? 680, flex: "none", boxSizing: "border-box" }}>
    <Story />
  </div>
);

/** The design's desktop column. */
export const desktop = { parameters: { googleWidth: 680 } };

/** A phone: the 320px column, opened by hand at the 320px viewport. */
export const narrow = { globals: viewportAt(320), parameters: { googleWidth: 320 } };

/* ── Fixtures: the Odysseus world, the week before 2026-07-12 ─────────── */

export const ODYSSEUS = "odysseus@example.com";
export const PENELOPE = "penelope@example.com";

const at = (short: string, full: string): GoogleHostTime => ({ short, full });
export const SAT_11 = at("Sat 11 Jul", "Saturday 11 July 2026 at 09:14");
export const FRI_10 = at("Fri 10 Jul", "Friday 10 July 2026 at 17:40");
export const THU_9 = at("Thu 9 Jul", "Thursday 9 July 2026 at 08:05");
export const WED_8 = at("Wed 8 Jul", "Wednesday 8 July 2026 at 19:22");
export const UNTIL_1802 = at("18:02", "Sunday 12 July 2026 at 18:02");
export const UNTIL_2140 = at("21:40", "Sunday 12 July 2026 at 21:40");

export const ARCHIVE: GoogleStandingAction = { kind: "archive" };
export const MARK_READ: GoogleStandingAction = { kind: "mark_read" };
export const STAR: GoogleStandingAction = { kind: "star" };
export const DRAFTS: GoogleStandingAction = { kind: "drafts" };
export const VOYAGE: GoogleStandingAction = { kind: "label", labelId: "Label_12", labelName: "Voyage" };
export const SUITORS: GoogleStandingAction = { kind: "unlabel", labelId: "Label_7", labelName: "Suitors" };
export const ESTATE: GoogleStandingAction = { kind: "label", labelId: "Label_31", labelName: "Estate · herds and orchards" };

/**
 * The longest name the host can hand over: Gmail's 225 code points, escaped
 * to ten characters each, 2,250 with no break opportunity anywhere. It is
 * drawn as the plain text the host sent, never decoded.
 */
export const LONG_LABEL_NAME = "&#x49;thac".repeat(225);

type Approvals = GoogleApprovalListProps["accounts"];
type Grants = GoogleAllowanceListProps["grants"];

/** The mock: one account, three remembered approvals. */
export const oneAccount = (): Approvals => [
  {
    address: ODYSSEUS,
    approvals: [
      { id: "appr-archive", action: ARCHIVE, since: SAT_11 },
      { id: "appr-voyage", action: VOYAGE, since: FRI_10 },
      { id: "appr-drafts", action: DRAFTS, since: THU_9 },
    ],
  },
];

export const twoAccounts = (): Approvals => [
  {
    address: ODYSSEUS,
    approvals: [
      { id: "appr-archive", action: ARCHIVE, since: SAT_11 },
      { id: "appr-voyage", action: VOYAGE, since: FRI_10 },
    ],
  },
  {
    address: PENELOPE,
    approvals: [
      { id: "appr-suitors", action: SUITORS, since: THU_9 },
      { id: "appr-estate", action: ESTATE, since: WED_8 },
    ],
  },
];

/** The mock: a two-action card with most of its budget left, and one nearly used. */
export const nearlyUsed = (): Grants => [
  { id: "card-ithaca", address: ODYSSEUS, actions: [ARCHIVE, MARK_READ], remaining: 84, limit: 100, until: UNTIL_1802 },
  { id: "card-drafts", address: ODYSSEUS, actions: [DRAFTS], remaining: 3, limit: 100, until: UNTIL_2140 },
];

/* ── Checks ───────────────────────────────────────────────────────────── */

type List = HTMLElement;

/** The list the story rendered. */
export function listIn(canvasElement: HTMLElement): List {
  const list = canvasElement.querySelector<HTMLElement>("[data-google-approvals], [data-google-allowances]");
  if (!list) throw new Error("the story rendered no Google list");
  return list;
}

/**
 * Every visible way the list's content escapes the list, as sentences.
 *
 * `overflowing()` from `_stage.tsx` measures each element's own box, which is
 * right for layout and wrong for a loading ghost: its sweep band travels
 * across a track wider than the ghost and is clipped by the ghost's own
 * viewport, so it is never seen outside it. Here each element's box is first
 * cut by every clipping ancestor inside the list; whatever is left must sit
 * inside the list on both axes. A box that paints nothing of its own (no
 * fill, border, shadow or text, like that viewport, drawn 8px taller than the
 * ghost as blur headroom) is skipped; what it holds is still measured. The
 * list's own scroll size is checked too.
 */
function paintsNothing(el: HTMLElement): boolean {
  if (/^(svg|img|canvas|video)$/i.test(el.tagName)) return false;
  const style = getComputedStyle(el);
  const borders = ["top", "right", "bottom", "left"].some((side) => parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0);
  const text = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
  return style.backgroundColor === "rgba(0, 0, 0, 0)" && style.backgroundImage === "none" && style.boxShadow === "none" && !borders && !text;
}

function escapes(list: List): string[] {
  const box = list.getBoundingClientRect();
  const out: string[] = [];
  if (list.scrollWidth > list.clientWidth + 1) out.push(`content is ${list.scrollWidth}px wide inside a ${list.clientWidth}px list`);
  for (const el of list.querySelectorAll<HTMLElement>("*")) {
    if ((el as unknown as { ownerSVGElement?: unknown }).ownerSVGElement) continue;
    if (paintsNothing(el)) continue;
    const own = el.getBoundingClientRect();
    if (own.width === 0 || own.height === 0) continue;
    let { left, top, right, bottom } = own;
    for (let up = el.parentElement; up && up !== list; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const clip = up.getBoundingClientRect();
      if (style.overflowX !== "visible") [left, right] = [Math.max(left, clip.left), Math.min(right, clip.right)];
      if (style.overflowY !== "visible") [top, bottom] = [Math.max(top, clip.top), Math.min(bottom, clip.bottom)];
    }
    if (right <= left || bottom <= top) continue;
    const name = `<${el.tagName.toLowerCase()}>${(el.textContent ?? "").trim().slice(0, 24)}`;
    if (right > box.right + 1) out.push(`${name} shows ${Math.round(right - box.right)}px past the right edge`);
    if (left < box.left - 1) out.push(`${name} shows ${Math.round(box.left - left)}px past the left edge`);
    if (bottom > box.bottom + 1) out.push(`${name} shows ${Math.round(bottom - box.bottom)}px past the bottom edge`);
    if (top < box.top - 1) out.push(`${name} shows ${Math.round(box.top - top)}px past the top edge`);
  }
  return out;
}

/** The document point (x, y) brought on screen, and what is hit there. */
function ownerAt(x: number, y: number): HTMLElement | null {
  window.scrollTo({ left: x - innerWidth / 2, top: y - innerHeight / 2, behavior: "instant" });
  const hit = document.elementFromPoint(x - scrollX, y - scrollY);
  return hit?.closest<HTMLElement>('[role="button"]') ?? null;
}

/**
 * A control's visible box and its touch target, from geometry. The target is
 * the border box grown by any absolutely positioned `::before` or `::after`,
 * which is how the kit reaches past paint (`.bk-hit`, #3252). Their insets
 * resolve against the padding box, so the border is added back.
 */
function geometry(control: HTMLElement) {
  const paint = control.getBoundingClientRect();
  const own = getComputedStyle(control);
  const inner = {
    left: paint.left + parseFloat(own.borderLeftWidth),
    top: paint.top + parseFloat(own.borderTopWidth),
    right: paint.right - parseFloat(own.borderRightWidth),
    bottom: paint.bottom - parseFloat(own.borderBottomWidth),
  };
  let { left, top, right, bottom } = paint;
  let pseudo = false;
  for (const which of ["::before", "::after"]) {
    const style = getComputedStyle(control, which);
    if (style.content === "none" || style.position !== "absolute") continue;
    pseudo = true;
    left = Math.min(left, inner.left + parseFloat(style.left));
    top = Math.min(top, inner.top + parseFloat(style.top));
    right = Math.max(right, inner.right - parseFloat(style.right));
    bottom = Math.max(bottom, inner.bottom - parseFloat(style.bottom));
  }
  return { paint, pseudo, reach: { left: left + scrollX, top: top + scrollY, right: right + scrollX, bottom: bottom + scrollY } };
}

/**
 * Every control's visible box is at least 24 x 24 and its touch target at
 * least 44 on both axes, and the target is the control's own: a probe 1px
 * inside each edge lands on it, so no neighbour's reach steals it.
 *
 * The touch floor is a coarse-pointer floor (#3252): under a fine pointer a
 * reaching control gains no reach, and the probe edges are its paint.
 */
async function targets(list: List) {
  const coarse = matchMedia("(any-pointer: coarse)").matches;
  const scroll = { left: scrollX, top: scrollY };
  const controls = [...list.querySelectorAll<HTMLElement>('[role="button"]')];
  for (const control of controls) {
    const label = control.getAttribute("aria-label") ?? control.textContent ?? "";
    const { paint, pseudo, reach } = geometry(control);
    await expect(paint.width, `${label}: visible width`).toBeGreaterThanOrEqual(24);
    await expect(paint.height, `${label}: visible height`).toBeGreaterThanOrEqual(24);
    const width = reach.right - reach.left;
    const height = reach.bottom - reach.top;
    if (coarse || !control.classList.contains("bk-hit")) {
      await expect(Math.round(width), `${label}: touch target width`).toBeGreaterThanOrEqual(44);
      await expect(Math.round(height), `${label}: touch target height`).toBeGreaterThanOrEqual(44);
    } else {
      await expect(pseudo, `${label}: a fine pointer gains no reach`).toBe(false);
    }
    const midX = (reach.left + reach.right) / 2;
    const midY = (reach.top + reach.bottom) / 2;
    const probes: [string, number, number][] = [
      ["top", midX, reach.top + 1],
      ["bottom", midX, reach.bottom - 1],
      ["left", reach.left + 1, midY],
      ["right", reach.right - 1, midY],
    ];
    for (const [edge, x, y] of probes) await expect(ownerAt(x, y), `${label}: its own ${edge} edge`).toBe(control);
  }
  window.scrollTo({ ...scroll, behavior: "instant" });
}

export interface Expected {
  /** The exact heading and explainer. */
  heading: string;
  explainer: string;
  /** Text that must appear, exactly, somewhere in the list. */
  copy?: string[];
  /** The Revoke controls' accessible names, in order. */
  names: string[];
}

/** What every story's play asserts about the rendered list. */
export async function looksRight(context: { canvasElement: HTMLElement; parameters: Record<string, unknown> }, expected: Expected) {
  const { canvasElement, parameters } = context;
  const list = listIn(canvasElement);
  await expect((parameters.a11y as { test?: string } | undefined)?.test, "the a11y gate is at error").toBe("error");
  await expect(list.getBoundingClientRect().width, "drew at its width").toBe(parameters.googleWidth);
  await expect(escapes(list), "nothing visible escapes the card").toEqual([]);

  const heading = within(list).getByRole("heading");
  await expect(heading.textContent).toBe(expected.heading);
  await expect(heading.tabIndex, "the heading is a focus target, never a tab stop").toBe(-1);
  await expect(list.querySelector("p")?.textContent, "the explainer").toBe(expected.explainer);
  const text = list.textContent ?? "";
  for (const line of expected.copy ?? []) await expect(text, "the exact copy").toContain(line);

  const buttons = within(list).queryAllByRole("button");
  await expect(buttons.length, "one Revoke control per row").toBe(expected.names.length);
  for (const [i, name] of expected.names.entries()) {
    await expect(within(list).getByRole("button", { name }), `Revoke control ${i + 1}'s accessible name`).toBe(buttons[i]);
  }
  await targets(list);
}

/** A click leaves focus, and its ring, on the control it hit. A play that
 * clicks ends here, so a capture of the story shows the list at rest. */
export function blurActive() {
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/** The text a reader is given: `textContent` without the `aria-hidden`
 * decoration, such as a loading ghost's glyphs. */
export function spokenText(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) hidden.remove();
  return copy.textContent ?? "";
}

/** The colour `accent.amber.ink` computes to here, for comparing a tone. */
export function amberInk(): string {
  const probe = document.createElement("span");
  probe.style.color = accent.amber.ink;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).color;
  } finally {
    probe.remove();
  }
}
