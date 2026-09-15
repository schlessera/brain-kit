import { describe, expect, test } from "bun:test";

import { TOKENS } from "../src/tokens.js";

/**
 * The contrast the kit actually has, measured rather than claimed.
 *
 * The design states that `#8a8691` is 5.10:1 on surface and calls it "the
 * floor". Wave 1b's brief was to verify that with axe rather than trust it. It
 * is true — and it is true only against the BARE surface. Ink-mute is the kit's
 * meta colour, it is used at 9-11px, and almost everywhere it appears there is
 * a tint, a raised ground or an `opacity` between it and that bare surface.
 * Each of those pushes it under 4.5:1.
 *
 * This file is the durable half of `.plan/design-feedback.md` §§4-7. The
 * numbers below are computed from the tokens so that THE MOMENT A TOKEN MOVES,
 * THIS TEST FAILS AND SAYS BY HOW MUCH. A comment would not have done that.
 *
 * They reproduce axe's own Chromium measurements to the hundredth in most cases
 * and to within 0.01 in the rest, where axe rounds the composite once more than
 * this does; each gap records axe's figure alongside. Nothing here is a target
 * to fix in code: a contrast failure is a design decision, and the decision has
 * not been made yet.
 */

type Rgb = [number, number, number];

function parse(value: string): { rgb: Rgb; alpha: number } {
  if (value.startsWith("#")) {
    const hex = value.length === 4 ? [...value.slice(1)].map((c) => c + c).join("") : value.slice(1);
    return { rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb, alpha: 1 };
  }
  const parts = value.match(/rgba?\(([^)]+)\)/)?.[1].split(",").map(Number);
  if (!parts) throw new Error(`not a colour: ${value}`);
  return { rgb: [parts[0]!, parts[1]!, parts[2]!], alpha: parts[3] ?? 1 };
}

/** Source-over compositing, which is what a browser does with a translucent
 * background and what `opacity` does to a whole subtree. Channels are rounded
 * because a rendered pixel is an integer, and the rounding is what makes these
 * numbers reproduce the hex values axe reported (`#64626b` on `#121417`) rather
 * than land a fraction off them. */
function over(top: { rgb: Rgb; alpha: number }, bottom: Rgb): Rgb {
  return bottom.map((b, i) => Math.round(top.alpha * top.rgb[i]! + (1 - top.alpha) * b)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG 2.x contrast, rounded to two places the way axe reports it. */
function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

const T = TOKENS as Record<string, string>;
const solid = (name: string) => parse(T[name]!).rgb;
const CANVAS = solid("color-canvas");
const SURFACE = solid("color-surface");
const RAISED = solid("color-raised");
const INK_MUTE = solid("color-ink-mute");

describe("contrast", () => {
  test("the design's floor claim is exactly right, on the bare grounds", () => {
    // "#8a8691 is 5.10:1 on surface" — verified, not trusted. This is the claim
    // the design makes and it holds to two decimal places.
    expect(contrast(INK_MUTE, SURFACE)).toBe(5.09);
    expect(contrast(INK_MUTE, CANVAS)).toBe(5.43);

    // And `raised` is where the floor stops being a floor with room to spare.
    expect(contrast(INK_MUTE, RAISED)).toBe(4.75);
  });

  test("the whole ink ramp clears 4.5:1 on all three bare grounds", () => {
    // The ramp itself is sound. Everything below is about what gets put BETWEEN
    // the ink and the ground.
    const failures: string[] = [];
    for (const ink of ["color-ink", "color-ink-dim", "color-ink-mute"]) {
      for (const [name, ground] of [["canvas", CANVAS], ["surface", SURFACE], ["raised", RAISED]] as const) {
        const ratio = contrast(solid(ink), ground);
        if (ratio < 4.5) failures.push(`${ink} on ${name} = ${ratio}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("every accent ink clears 4.5:1 on all three bare grounds", () => {
    const failures: string[] = [];
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red", "neutral"]) {
      for (const [name, ground] of [["canvas", CANVAS], ["surface", SURFACE], ["raised", RAISED]] as const) {
        const ratio = contrast(solid(`${tone}-ink`), ground);
        if (ratio < 4.5) failures.push(`${tone}-ink on ${name} = ${ratio}`);
      }
    }
    expect(failures).toEqual([]);
  });

  /* ── The four documented contrast gaps — design-feedback §§4-7 ─────────────────────────────────────────── */

  test("§4 — `opacity` drops ink under the floor, and it is the widest one", () => {
    // `QueueItemRow` fades a superseded row to .7 and `NotificationCard` fades a
    // dim one to .8. `opacity` renders the WHOLE subtree to a layer and then
    // composites that layer against the backdrop, so it is not a styling choice
    // that happens to touch contrast — it is a contrast change applied to every
    // colour in the row at once, including the ones that were only just clearing
    // the floor. Both the text and the ground it sits on end up composited
    // against the CANVAS behind the row, which is why the ground moves too.
    function faded(alpha: number, ink: Rgb, ground: Rgb) {
      return contrast(over({ rgb: ink, alpha }, CANVAS), over({ rgb: ground, alpha }, CANVAS));
    }

    // QueueItemRow superseded, opacity .7. Axe: #8a8691 -> #64626b on #121417,
    // measured 3.07.
    expect(faded(0.7, INK_MUTE, SURFACE)).toBe(3.08);
    // ...and the teal it uses to mean something goes down with it. Axe: 4.17.
    expect(faded(0.7, solid("teal-ink"), SURFACE)).toBe(4.17);
    // NotificationCard dim, opacity .8 over its own translucent ground. Axe: 3.72.
    const dimGround = over(parse(T["notification-bg-dim"]!), CANVAS);
    expect(faded(0.8, INK_MUTE, dimGround)).toBe(3.72);

    // The shape of the finding: at .7 even ink-DIM, a full step brighter than
    // the floor, is only just clear. There is no headroom in the ramp for a
    // second fade on top of a tint.
    expect(faded(0.7, solid("color-ink-dim"), SURFACE)).toBeLessThan(6);
  });

  test("§5 — ink-mute falls under 4.5 on EVERY tint, not on a few", () => {
    // The floor is measured against a bare ground and the kit almost never has
    // one. This counts the tints rather than listing them, because the finding
    // is the proportion: it is not that six tints are unlucky.
    const tints = Object.keys(T).filter((name) => /tint/.test(name) && T[name]!.startsWith("rgba"));
    const overSurface = tints.filter((name) => contrast(INK_MUTE, over(parse(T[name]!), SURFACE)) < 4.5);
    const overRaised = tints.filter((name) => contrast(INK_MUTE, over(parse(T[name]!), RAISED)) < 4.5);

    expect(tints.length).toBe(81);
    // Over `raised`, ink-mute fails on every single translucent tint the kit has.
    expect(overRaised.length).toBe(81);
    // Over `surface` it survives on the faintest 47 and fails on the rest.
    expect(overSurface.length).toBe(34);

    // The instance axe actually failed: ChoiceOption's detail line on a selected
    // option, which is every AskUserCard story. Axe measured 4.35.
    const selected = over(parse(T["choice-tint-selected"]!), SURFACE);
    expect(contrast(INK_MUTE, selected)).toBe(4.36);
  });

  test("§6 — the count chip's white on red is 2.76:1, at 9px", () => {
    // `Chip variant="count"` paints `--bk-chip-count-ink` on the solid tone
    // fill. Every fill in the palette was chosen to glow against near-black, so
    // white on any of them is the wrong way round; red is simply the one the
    // count badge uses.
    // Axe measured 2.76.
    expect(contrast(solid("chip-count-ink"), solid("red-fill"))).toBe(2.77);

    // The design's own answer is already in the palette, one row up: near-black
    // ON the fill, which is what a solid Button does.
    expect(contrast(CANVAS, solid("red-fill"))).toBe(6.98);
  });

  test("§7 — a solid button's effect chip is under the floor on every tone", () => {
    // Axe did NOT catch this one, because no story renders a solid button with
    // an effect chip — which is worth saying plainly, since "axe is green" and
    // "the palette is sound" are different claims and this is where they part.
    //
    // It is §6 seen from the other side: `--bk-button-ink-on-solid` is
    // near-black at .62 alpha, a mid grey once composited, and a mid grey on a
    // fill chosen to glow against near-black is neither. The chip's own ground
    // darkens the fill slightly and still does not rescue it.
    const ink = parse(T["button-ink-on-solid"]!);
    const chipGround = parse(T["button-effect-bg-on-solid"]!);
    const measured: Record<string, number> = {};
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red"]) {
      const ground = over(chipGround, solid(`${tone}-fill`));
      measured[tone] = contrast(over(ink, ground), ground);
    }
    expect(Object.values(measured).every((ratio) => ratio < 4.5)).toBe(true);
    expect(measured.amber).toBe(3.3);
    expect(measured.red).toBe(2.99);

    // The label beside it is `--bk-color-canvas` on the bare fill and is fine,
    // so the chip is the only thing on a solid button that fails. That is what
    // makes it a palette decision rather than a layout one.
    expect(contrast(CANVAS, solid("amber-fill"))).toBe(8.46);
  });
});
