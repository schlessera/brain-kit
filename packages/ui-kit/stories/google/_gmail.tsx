// Shared furniture for the Gmail stories (#4209): the two widths every state
// is drawn at, and the assertions every story makes at both, in both themes.

import { expect } from "storybook/test";

import { viewportAt } from "../_viewports.js";

/** A phone: the 320px viewport, so width media queries answer as they would on one. */
export const narrow = { globals: viewportAt(320), parameters: { stageWidth: "none" } };

/** The design's desktop card width. */
export const desktop = { parameters: { stageWidth: 680 } };

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const box = (rect: DOMRect | Box): Box => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
const union = (a: Box, b: Box): Box => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });
const size = (b: Box) => ({ width: Math.max(0, b.right - b.left), height: Math.max(0, b.bottom - b.top) });

/** A coarse-pointer media condition, and the same as a pattern to rewrite it to one that always holds. */
const COARSE = /\((?:any-)?pointer:\s*coarse\)/;
const COARSE_ALL = new RegExp(COARSE.source, "g");

/**
 * Runs `measure` with every same-origin `@media (…pointer: coarse)` rule
 * applied, as a touch screen would draw the page: the story projects run
 * under a fine pointer, where `.bk-hit`'s reach does not exist. The rules
 * are copied from the page's own stylesheets, so a deleted or broken reach
 * rule is measured as missing, never assumed from a class name.
 */
function underCoarsePointer<T>(measure: () => T): T {
  const rules: string[] = [];
  const walk = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSMediaRule && COARSE.test(rule.conditionText)) {
        rules.push(`@media ${rule.conditionText.replace(COARSE_ALL, "(min-width: 0px)")} { ${Array.from(rule.cssRules, (inner) => inner.cssText).join("\n")} }`);
      } else if ("cssRules" in rule) {
        walk((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A cross-origin sheet (a font): no pointer rules of the kit's in it.
    }
  }
  const style = document.createElement("style");
  style.dataset.coarsePointerProbe = "";
  style.textContent = rules.join("\n");
  document.head.append(style);
  try {
    return measure();
  } finally {
    style.remove();
  }
}

/** Where an absolutely positioned `::before` or `::after` of `control` lies, from its computed insets. */
function pseudoBox(control: HTMLElement, style: CSSStyleDeclaration): Box {
  const px = (value: string) => (/^-?\d+(\.\d+)?px$/.test(value) ? parseFloat(value) : Number.NaN);
  const [top, right, bottom, left] = [style.top, style.right, style.bottom, style.left].map(px) as [number, number, number, number];
  const own = getComputedStyle(control);
  if (own.position !== "static" && [top, right, bottom, left].every(Number.isFinite)) {
    // The containing block is the control's padding box.
    const outer = control.getBoundingClientRect();
    return {
      left: outer.left + parseFloat(own.borderLeftWidth) + left,
      top: outer.top + parseFloat(own.borderTopWidth) + top,
      right: outer.right - parseFloat(own.borderRightWidth) - right,
      bottom: outer.bottom - parseFloat(own.borderBottomWidth) - bottom,
    };
  }
  // Insets the browser left unresolved: lay out a probe with the same ones, in the same containing block.
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;top:${style.top};right:${style.right};bottom:${style.bottom};left:${style.left};width:${style.width};height:${style.height}`;
  control.append(probe);
  try {
    return box(probe.getBoundingClientRect());
  } finally {
    probe.remove();
  }
}

/** `reach` cut to what every clipping ancestor lets through: a clipped reach takes no touch. */
function clip(control: HTMLElement, reach: Box): Box {
  let out = reach;
  for (let a = control.parentElement; a; a = a.parentElement) {
    const style = getComputedStyle(a);
    const clipX = style.overflowX !== "visible";
    const clipY = style.overflowY !== "visible";
    if (!clipX && !clipY) continue;
    const edge = a.getBoundingClientRect();
    out = {
      left: clipX ? Math.max(out.left, edge.left) : out.left,
      right: clipX ? Math.min(out.right, edge.right) : out.right,
      top: clipY ? Math.max(out.top, edge.top) : out.top,
      bottom: clipY ? Math.min(out.bottom, edge.bottom) : out.bottom,
    };
  }
  return out;
}

/** What a touch can land on: the control's box under a coarse pointer, with its positioned `::before` and `::after`, clipped. */
function touchReach(control: HTMLElement): Box {
  let reach = box(control.getBoundingClientRect());
  for (const pseudo of ["::before", "::after"] as const) {
    const style = getComputedStyle(control, pseudo);
    if (style.content === "none" || style.content === "normal" || style.display === "none" || style.position !== "absolute") continue;
    reach = union(reach, pseudoBox(control, style));
  }
  return clip(control, reach);
}

/** A control a story measures: its name, its visible box under the story's fine pointer, and its touch reach. */
interface Target {
  name: string;
  box: { width: number; height: number };
  reach: { width: number; height: number };
}

/** Every control in `root`, measured. Links inside untrusted prose take 2.5.8's inline exception; hidden ones are not on screen. */
export function targets(root: HTMLElement): Target[] {
  const controls = [...root.querySelectorAll<HTMLElement>("button, [role='button'], a[href]")].filter((c) => !c.matches("[data-untrusted-link]") && !c.closest("[hidden]"));
  const boxes = controls.map((c) => size(box(c.getBoundingClientRect())));
  const reaches = underCoarsePointer(() => controls.map((c) => size(touchReach(c))));
  return controls.map((c, i) => ({ name: c.getAttribute("aria-label") ?? c.textContent?.trim().slice(0, 40) ?? "", box: boxes[i]!, reach: reaches[i]! }));
}

/**
 * Every control in `root` that is not a full target, by name and size. Its
 * visible box, as the story's fine pointer draws it, must be at least 24px
 * each way (WCAG 2.5.8). Its touch reach, measured with the page's own
 * coarse-pointer rules applied — the box, the inline text control's
 * `::before`, `.bk-hit`'s `::after` (`Button`'s `reach`), cut by any
 * clipping ancestor — must be at least 44px each way.
 */
export function smallTargets(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const t of targets(root)) {
    const smallBox = t.box.width < 24 - 0.5 || t.box.height < 24 - 0.5;
    const shortReach = t.reach.width < 44 - 0.5 || t.reach.height < 44 - 0.5;
    if (smallBox || shortReach) {
      out.push(`${t.name}: box ${Math.round(t.box.width)}×${Math.round(t.box.height)}, touch reach ${Math.round(t.reach.width)}×${Math.round(t.reach.height)}`);
    }
  }
  return out;
}

/**
 * Every element whose VISIBLE part escapes `root`, as sentences. Like
 * `overflowing` in `_stage.tsx`, but an element clipped by an `overflow`
 * ancestor inside the card (an ellipsis, the loading ghost's sliding track)
 * counts only for what shows. The card's own scroll width is checked too.
 */
export function escapes(root: HTMLElement): string[] {
  const box = root.getBoundingClientRect();
  const out: string[] = [];
  if (root.scrollWidth > root.clientWidth + 1) out.push(`content is ${root.scrollWidth}px wide inside a ${root.clientWidth}px box`);
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if ((el as unknown as { ownerSVGElement?: unknown }).ownerSVGElement) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    let left = rect.left;
    let right = rect.right;
    for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === "visible") continue;
      const clip = a.getBoundingClientRect();
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (right <= left) continue;
    const name = `<${el.tagName.toLowerCase()}>${(el.textContent ?? "").trim().slice(0, 24)}`;
    if (right > box.right + 1) out.push(`${name} shows ${Math.round(right - box.right)}px past the right edge`);
    if (left < box.left - 1) out.push(`${name} shows ${Math.round(box.left - left)}px past the left edge`);
  }
  return out;
}

const CARD = "[data-gmail-results], [data-gmail-thread], [data-gmail-message], [data-gmail-labels]";

/** Every card the story drew, outermost only: a label list inside a card is part of that card. */
export const cards = (canvasElement: HTMLElement) => [...canvasElement.querySelectorAll<HTMLElement>(CARD)].filter((el) => !el.parentElement?.closest(CARD));

/** The card the story drew. */
export const card = (canvasElement: HTMLElement) => cards(canvasElement)[0]!;

/**
 * What every Gmail story asserts, at its width and in its theme, for every
 * card it drew: it drew at that width, nothing escapes the card, and every
 * control is a full target. `controls` is how many controls the story
 * claims at least (1 unless it says otherwise), so a story whose controls
 * vanished cannot pass the target check by measuring nothing.
 */
export async function holdsTogether(canvasElement: HTMLElement, width: "narrow" | "desktop", { controls = 1 }: { controls?: number } = {}) {
  const drawn = cards(canvasElement);
  await expect(drawn.length, "the story drew its component").toBeGreaterThan(0);
  if (width === "narrow") {
    await expect(window.innerWidth, "the phone story runs at the 320px viewport").toBe(320);
  } else {
    const column = canvasElement.firstElementChild as HTMLElement;
    await expect(column.getBoundingClientRect().width, "the desktop story draws in the 680px column").toBe(680);
  }
  let measured = 0;
  for (const root of drawn) {
    if (width === "desktop" && !root.matches("[data-gmail-labels]")) await expect(root.getBoundingClientRect().width, "the card fills its column").toBeGreaterThan(660);
    await expect(escapes(root), "nothing escapes the card").toEqual([]);
    await expect(smallTargets(root), "every control is a 24px box with a 44px touch reach, both ways").toEqual([]);
    measured += targets(root).length;
  }
  if (controls === 0) await expect(measured, "the story claims no controls").toBe(0);
  else await expect(measured, `the story's controls (at least ${controls}) are there to measure`).toBeGreaterThanOrEqual(controls);
}

/** The width a story is drawn at, from its own parameters. */
export const widthOf = (parameters: Record<string, unknown>): "narrow" | "desktop" => (parameters.stageWidth === "none" ? "narrow" : "desktop");

/**
 * Where each needle appears in `root`: `unguarded` lists every text node
 * holding one outside an untrusted field or text block, `guarded` every
 * needle found at least once inside one. Asserting both proves containment
 * of text that is really on screen.
 */
export function containment(root: HTMLElement, needles: string[]): { unguarded: string[]; guarded: string[] } {
  const unguarded: string[] = [];
  const guarded = new Set<string>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    for (const needle of needles) {
      if (!value.includes(needle)) continue;
      if (node.parentElement?.closest("[data-untrusted-field], [data-untrusted-text]")) guarded.add(needle);
      else unguarded.push(needle);
    }
  }
  return { unguarded, guarded: needles.filter((needle) => guarded.has(needle)) };
}
