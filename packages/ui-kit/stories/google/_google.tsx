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
 * Clipped element-box containment: every element box in the list, cut by its
 * clipping ancestors, as sentences for each one that still sits outside the
 * list.
 *
 * This measures element boxes, not ink: a shadow or a pseudo-element's paint
 * outside a box is not seen, and text a clipping ancestor hides is not an
 * escape. `clippedText()` covers the text. `overflowing()` from `_stage.tsx`
 * measures each element's own box, which is right for layout and wrong for a
 * loading ghost: its sweep band travels across a track wider than the ghost
 * and is clipped by the ghost's own viewport, so it is never seen outside it.
 * Here each box is first cut by every clipping ancestor inside the list. A box
 * that paints nothing of its own (no fill, border, shadow or text, like that
 * viewport, drawn 8px taller than the ghost as blur headroom) is skipped; what
 * it holds is still measured. The list's own scroll size is checked too.
 */
function paintsNothing(el: HTMLElement): boolean {
  if (/^(svg|img|canvas|video)$/i.test(el.tagName)) return false;
  const style = getComputedStyle(el);
  const borders = ["top", "right", "bottom", "left"].some((side) => parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0);
  const text = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
  return style.backgroundColor === "rgba(0, 0, 0, 0)" && style.backgroundImage === "none" && style.boxShadow === "none" && !borders && !text;
}

function boxEscapes(list: List): string[] {
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

/**
 * Text the card would hide by clipping, as sentences. A `Surface` clips, so a
 * label name, an address or an action title that outgrew its box would vanish
 * rather than escape. Every title, address and count line is a block that
 * must hold all of its text: no wider or taller content than its box, no
 * ellipsis, and no clipping ancestor cutting it off.
 */
function clippedText(list: List): string[] {
  const out: string[] = [];
  for (const box of list.querySelectorAll<HTMLElement>("[data-google-title], [data-google-address], [data-google-meta]")) {
    const name = `"${(box.textContent ?? "").trim().slice(0, 32)}"`;
    if (box.clientWidth === 0) out.push(`${name} has no box to hold its text`);
    if (box.scrollWidth > box.clientWidth) out.push(`${name} holds ${box.scrollWidth}px of text in ${box.clientWidth}px`);
    if (box.scrollHeight > box.clientHeight) out.push(`${name} holds ${box.scrollHeight}px of text in ${box.clientHeight}px of height`);
    if (getComputedStyle(box).textOverflow === "ellipsis") out.push(`${name} can end in an ellipsis`);
    // An enclosing box that clips can hide a fully sized text box (#4212 re-review R2):
    // the text must lie inside every clipping ancestor's client box, up to the list root.
    const own = box.getBoundingClientRect();
    for (let el = box.parentElement; el && list.contains(el); el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const r = el.getBoundingClientRect();
      const left = r.left + el.clientLeft, top = r.top + el.clientTop;
      if (own.left < left - 0.5 || own.top < top - 0.5 || own.right > left + el.clientWidth + 0.5 || own.bottom > top + el.clientHeight + 0.5) {
        out.push(`${name} is cut off by an enclosing box that clips`);
        break;
      }
    }
  }
  return out;
}

/**
 * The loading placeholder's ghost lines: those of the `aria-busy` box, not
 * the copies the sweep band clones into its own viewport.
 */
export function ghostLines(list: List): HTMLElement[] {
  const busy = list.querySelector<HTMLElement>("[aria-busy='true']");
  return busy ? [...busy.querySelectorAll<HTMLElement>(".bk-ghost")].filter((ghost) => !ghost.closest(".bk-ghost-viewport")) : [];
}

/** Loading draws the busy placeholder: exactly two ghost lines, each painted with real height. */
export async function loadingRows(list: List) {
  await expect(list.querySelector("[aria-busy='true']"), "the placeholder says it is loading").not.toBeNull();
  const lines = ghostLines(list);
  await expect(lines, "exactly two ghost lines").toHaveLength(2);
  for (const [i, line] of lines.entries()) {
    await expect(line.getBoundingClientRect().height, `ghost line ${i + 1} has height`).toBeGreaterThan(0);
    await expect(line.checkVisibility({ visibilityProperty: true, opacityProperty: true }), `ghost line ${i + 1} is visible`).toBe(true);
  }
}

/**
 * A finished read that failed: the kit's error state, and nothing that says
 * a read is running (no `aria-busy`, no ghost) or that the list is empty.
 */
export async function failedRead(list: List, claims: { failed: string; detail: string; empty: string; unavailable: string }) {
  const box = list.querySelector<HTMLElement>("[data-google-failed]");
  await expect(box, "the failed state is drawn").not.toBeNull();
  await expect(box!.textContent, "the failure, then what it means").toContain(`${claims.failed}${claims.detail}`);
  await expect(list.querySelector("[aria-busy]"), "nothing claims to be loading").toBeNull();
  await expect(list.querySelectorAll(".bk-ghost"), "no loading ghost").toHaveLength(0);
  await expect(list.textContent, "no empty claim").not.toContain(claims.empty);
  await expect(list.textContent, "no unavailable claim").not.toContain(claims.unavailable);
  await expect(list.querySelector("[data-google-unshown]"), "no count notice").toBeNull();
}

/**
 * Rows the host holds but cannot show: the count notice, after any rows and
 * before any revoke-error banner, and never the empty line.
 */
export async function unshownNotice(list: List, expected: { count: number; text: string; empty: string }) {
  const notice = list.querySelector<HTMLElement>("[data-google-unshown]");
  await expect(notice, "the count notice is drawn").not.toBeNull();
  await expect(notice!.getAttribute("data-google-unshown")).toBe(String(expected.count));
  await expect(notice!.textContent, "the count notice's copy").toBe(expected.text);
  await expect(list.textContent, "rows that exist are never called none").not.toContain(expected.empty);
  const rows = [...list.querySelectorAll<HTMLElement>("[data-google-target]")];
  if (rows.length) await expect(notice!.getBoundingClientRect().top, "the notice is under the rows").toBeGreaterThanOrEqual(rows.at(-1)!.getBoundingClientRect().bottom);
  const alert = list.querySelector<HTMLElement>("[role='alert']");
  if (alert) await expect(alert.getBoundingClientRect().top, "a revoke error sits under the notice").toBeGreaterThanOrEqual(notice!.getBoundingClientRect().bottom);
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
/** Slack for float arithmetic in a computed 44px, never a rounding: a 43.65px
 * target is under the floor (#3252), and 44 - 0.01 still says so. */
const FLOAT_SLACK = 0.01;

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
      await expect(width, `${label}: touch target width (${width.toFixed(2)}px)`).toBeGreaterThanOrEqual(44 - FLOAT_SLACK);
      await expect(height, `${label}: touch target height (${height.toFixed(2)}px)`).toBeGreaterThanOrEqual(44 - FLOAT_SLACK);
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
  /** The list's own controls after the rows (Try again), by accessible name. */
  controls?: string[];
  /** Each list's item count, in order: one list per card. */
  lists: number[];
  /** The named groups' names, in order: one per approval account. */
  groups: string[];
}

/** What every story's play asserts about the rendered list. */
export async function looksRight(context: { canvasElement: HTMLElement; parameters: Record<string, unknown> }, expected: Expected) {
  const { canvasElement, parameters } = context;
  const list = listIn(canvasElement);
  await expect((parameters.a11y as { test?: string } | undefined)?.test, "the a11y gate is at error").toBe("error");
  await expect(list.getBoundingClientRect().width, "drew at its width").toBe(parameters.googleWidth);
  await expect(boxEscapes(list), "no element box escapes the card (clipped containment)").toEqual([]);
  await expect(list.querySelectorAll("[data-google-title]").length, "one action title per row").toBe(expected.names.length);
  await expect(clippedText(list), "no title, address or count is clipped").toEqual([]);

  const heading = within(list).getByRole("heading");
  await expect(heading.textContent).toBe(expected.heading);
  await expect(heading.tabIndex, "the heading is a focus target, never a tab stop").toBe(-1);
  await expect(list.querySelector("p")?.textContent, "the explainer").toBe(expected.explainer);
  const text = list.textContent ?? "";
  for (const line of expected.copy ?? []) await expect(text, "the exact copy").toContain(line);

  const buttons = within(list).queryAllByRole("button");
  const controls = expected.controls ?? [];
  await expect(buttons.length, "one Revoke control per row, then the list's own").toBe(expected.names.length + controls.length);
  for (const [i, name] of expected.names.entries()) {
    await expect(within(list).getByRole("button", { name }), `Revoke control ${i + 1}'s accessible name`).toBe(buttons[i]);
  }
  for (const [i, name] of controls.entries()) {
    await expect(within(list).getByRole("button", { name }), `the list's control "${name}"`).toBe(buttons[expected.names.length + i]);
  }
  const lists = within(list).queryAllByRole("list");
  await expect(lists.map((ul) => within(ul).queryAllByRole("listitem").length), "a list per card, an item per row").toEqual(expected.lists);
  const groups = within(list).queryAllByRole("group");
  await expect(groups.length, "one named group per account").toBe(expected.groups.length);
  for (const [i, name] of expected.groups.entries()) {
    await expect(within(list).getByRole("group", { name }), `group ${i + 1} is named by its address`).toBe(groups[i]);
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
