import { describe, expect, test } from "bun:test";

import { LIGHT_TOKENS, TOKENS } from "../src/tokens.js";
import { contrast, over, parse, type Rgb } from "./_contrast.js";

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
 * This file is the durable half of `docs/decisions/design-feedback.md` §§4-7. The
 * numbers below are computed from the tokens so that THE MOMENT A TOKEN MOVES,
 * THIS TEST FAILS AND SAYS BY HOW MUCH. A comment would not have done that.
 *
 * They reproduce axe's own Chromium measurements to the hundredth in most cases
 * and to within 0.01 in the rest, where axe rounds the composite once more than
 * this does; each gap records axe's figure alongside. Nothing here is a target
 * to fix in code: a contrast failure is a design decision, and the decision has
 * not been made yet.
 */

const T = TOKENS as Record<string, string>;
const solid = (name: string) => parse(T[name]!).rgb;
const CANVAS = solid("color-canvas");
const SURFACE = solid("color-surface");
const RAISED = solid("color-raised");
const INK_MUTE = solid("color-ink-mute");

describe("contrast", () => {
  test("the floor moved to #9a96a1, and the design's new claims hold on the bare grounds", () => {
    // "#8a8691 is 5.10:1 on surface" was the first claim, verified at 5.09 and
    // 4.75 on raised. The fourth drop (2026-09-18) restated the floor against
    // the worst ground it lands on — "6.26 on surface, 5.83 on raised, 4.80 on
    // the worst documented tint" — and moved it to #9a96a1. Verified, not
    // trusted, to two decimals.
    expect(contrast(INK_MUTE, SURFACE)).toBe(6.26);
    expect(contrast(INK_MUTE, RAISED)).toBe(5.83);
    expect(contrast(INK_MUTE, CANVAS)).toBe(6.67);
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

  test("§4 — `opacity` drops ink under the floor, and the kit no longer fades a row", () => {
    // `QueueItemRow` USED to fade a superseded row to .7 and `NotificationCard`
    // fades a dim one to .8. `opacity` renders the WHOLE subtree to a layer and then
    // composites that layer against the backdrop, so it is not a styling choice
    // that happens to touch contrast — it is a contrast change applied to every
    // colour in the row at once, including the ones that were only just clearing
    // the floor. Both the text and the ground it sits on end up composited
    // against the CANVAS behind the row, which is why the ground moves too.
    function faded(alpha: number, ink: Rgb, ground: Rgb) {
      return contrast(over({ rgb: ink, alpha }, CANVAS), over({ rgb: ground, alpha }, CANVAS));
    }

    // QueueItemRow superseded at opacity .7 measured 3.08 with the old floor
    // (axe: #8a8691 -> #64626b on #121417, 3.07) and would still be under it
    // with the new one — which is why the design's answer was to drop the fade,
    // not to find a brighter ink: "a superseded row is not lower-contrast at
    // all. It reads as superseded from its state word and its still, neutral
    // dot, at full ink contrast." The kit no longer sets opacity on the row.
    expect(faded(0.7, INK_MUTE, SURFACE)).toBeLessThan(4.5);
    expect(faded(0.7, INK_MUTE, SURFACE)).toBe(3.62);
    // ...and the teal it uses to mean something goes down with it. Axe: 4.17.
    expect(faded(0.7, solid("teal-ink"), SURFACE)).toBe(4.17);
    // NotificationCard dim, opacity .8 over its own translucent ground, is
    // still the one fade left and is still under the floor. The design's rule
    // ("the only surviving opacity is .45 on a disabled control") says it goes
    // too; it is a variant of a lock-screen mock and stays recorded rather
    // than restyled here.
    const dimGround = over(parse(T["notification-bg-dim"]!), CANVAS);
    expect(faded(0.8, INK_MUTE, dimGround)).toBeLessThan(4.5);

    // The shape of the finding: at .7 even ink-DIM, a full step brighter than
    // the floor, is only just clear. There is no headroom in the ramp for a
    // second fade on top of a tint.
    expect(faded(0.7, solid("color-ink-dim"), SURFACE)).toBeLessThan(6);
  });

  test("§5 — RESOLVED: ink-mute clears the floor on the worst documented tint", () => {
    // With the old floor ink-mute failed on all 81 translucent tints over
    // `raised` and on 34 of them over `surface`; the instance axe caught was a
    // selected ChoiceOption's detail line at 4.36. The fourth drop states the
    // floor against "the worst documented tint (4-10% of any fill over either
    // ground)" at 4.80, which is the same correction the light palette needed
    // (§19). `-tint-`, not `tinted`: the five `action-border-tinted-*` strokes
    // are borders, and the first count of 81 had swept them in as grounds.
    // 76 became 79 with the seventh drop: the lapsed row's gold ground and
    // the two tinted-diff grounds, all under the 10% the floor is stated for.
    const tints = Object.keys(T).filter((name) => /(^|-)tint(-|$)/.test(name) && T[name]!.startsWith("rgba"));
    const overSurface = tints.filter((name) => contrast(INK_MUTE, over(parse(T[name]!), SURFACE)) < 4.5);
    const overRaised = tints.filter((name) => contrast(INK_MUTE, over(parse(T[name]!), RAISED)) < 4.5);

    expect(tints.length).toBe(79);
    expect(overSurface).toEqual([]);
    expect(overRaised).toEqual([]);

    // The instance that failed axe: 4.36 then, clear now.
    const selected = over(parse(T["choice-tint-selected"]!), SURFACE);
    expect(contrast(INK_MUTE, selected)).toBeGreaterThanOrEqual(4.8);
  });

  test("§6 — the count chip takes on-fill now, and clears the floor on every fill", () => {
    // `Chip variant="count"` USED to paint white on the solid tone fill —
    // 2.77:1 on red at 9px, the widest single miss in the kit. The 2026-09-18
    // drop resolved it the way §6 predicted: a count badge is a solid fill like
    // any other and takes near-black ink. The token is now a reference to
    // `on-fill`, and the number that was 2.77 is 6.98.
    expect(T["chip-count-ink"]).toBe("var(--bk-on-fill)");
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red"]) {
      expect(contrast(solid("on-fill"), solid(`${tone}-fill`))).toBeGreaterThan(4.5);
    }
    expect(contrast(solid("on-fill"), solid("red-fill"))).toBe(6.98);
  });

  test("§7 — RESOLVED: the well on a solid button lightens, and the chip clears the floor", () => {
    // Axe did NOT catch this one, because no story renders a solid button with
    // an effect chip — which is worth saying plainly, since "axe is green" and
    // "the palette is sound" are different claims and this is where they part.
    //
    // It was §6 seen from the other side: `--bk-button-ink-on-solid` was
    // near-black at .62 alpha, a mid grey once composited, and the chip's own
    // ground darkened the fill — amber 3.3, red 2.99. The fourth drop's rule:
    // "a well over a fill LIGHTENS it (rgba(255,255,255,.28)): a dark well sat
    // at 4.99–6.18, the light one reaches 9.26–12.25", and the ink is opaque
    // on-fill at weight 500+.
    expect(T["button-ink-on-solid"]).toBe("#0c0e12");
    expect(T["button-effect-bg-on-solid"]).toBe("rgba(255,255,255,0.28)");
    const ink = parse(T["button-ink-on-solid"]!);
    const chipGround = parse(T["button-effect-bg-on-solid"]!);
    const measured: Record<string, number> = {};
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red"]) {
      const ground = over(chipGround, solid(`${tone}-fill`));
      measured[tone] = contrast(over(ink, ground), ground);
    }
    expect(Object.values(measured).every((ratio) => ratio >= 4.5)).toBe(true);
    expect(Math.min(...Object.values(measured))).toBeGreaterThanOrEqual(9);

    // The label beside it is `on-fill` on the bare fill and always was fine.
    expect(contrast(CANVAS, solid("amber-fill"))).toBe(8.46);
  });

  /* ── The light theme, measured the same way ─────────────────────────────── */

  const L = LIGHT_TOKENS as Record<string, string>;
  const paper = (name: string) => parse(L[name]!).rgb;
  const P_CANVAS = paper("color-canvas");
  const P_SURFACE = paper("color-surface");
  const P_RAISED = paper("color-raised");

  test("light — the design's own ratios hold: 15.1 / 7.4 / 5.3 on surface", () => {
    // `Brain Kit Light.dc.html` §L1 (revised) states these against the light
    // surface. Verified, not trusted, the same way the dark floor was; the
    // design quotes one decimal and truncates.
    expect(contrast(paper("color-ink"), P_SURFACE)).toBe(15.05);
    expect(contrast(paper("color-ink-dim"), P_SURFACE)).toBe(7.45);
    expect(contrast(paper("color-ink-mute"), P_SURFACE)).toBeGreaterThanOrEqual(5.3);
  });

  test("light — the ink ramp and every accent ink clear 4.5:1 on all three grounds", () => {
    const failures: string[] = [];
    const inks = ["color-ink", "color-ink-dim", "color-ink-mute", "amber-ink", "gold-ink", "teal-ink", "purple-ink", "blue-ink", "red-ink", "neutral-ink"];
    for (const ink of inks) {
      for (const [name, ground] of [["canvas", P_CANVAS], ["surface", P_SURFACE], ["raised", P_RAISED]] as const) {
        const ratio = contrast(paper(ink), ground);
        if (ratio < 4.5) failures.push(`${ink} on ${name} = ${ratio}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("light — every accent ink clears the floor on its OWN tinted ground, on surface", () => {
    // "Test on the tint, not the surface": the tint darkens the backdrop a few
    // percent, which is enough — teal and gold both had to come down a notch
    // after being measured on the cards they actually appear in. So this
    // measures each ink over every tint of its own hue the kit defines.
    const failures: string[] = [];
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red"]) {
      // `-tint-`, not `tinted`: a border is a stroke, not a ground.
      const tints = Object.keys(L).filter((n) => /(^|-)tint(-|$)/.test(n) && n.endsWith(`-${tone}`) && L[n]!.startsWith("rgba"));
      expect(tints.length).toBeGreaterThan(3);
      for (const tint of tints) {
        const ground = over(parse(L[tint]!), P_SURFACE);
        const ratio = contrast(paper(`${tone}-ink`), ground);
        if (ratio < 4.5) failures.push(`${tone}-ink over ${tint} = ${ratio}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("light — on-fill clears 4.5:1 on every fill, and on-ink-solid on the ink discs", () => {
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red", "neutral"]) {
      expect(contrast(paper("on-fill"), paper(`${tone}-fill`))).toBeGreaterThan(4.5);
    }
    // A selected option's mark and a done step's bubble are the teal INK with
    // surface on top.
    expect(contrast(paper("on-ink-solid"), paper("teal-ink"))).toBeGreaterThan(4.5);
  });

  test("light — §5 IS solved on paper: ink-mute clears every tint over the surface", () => {
    // In the dark theme ink-mute fails on every translucent tint over `raised`
    // and on 34 of 81 over `surface` (§5, still open). The revised light palette
    // states its floor against a tint over the canvas, and a floor stated
    // against the worst ground holds on the better ones for free — which is
    // the whole argument of §5, demonstrated on paper. If this ever counts
    // above zero the palette moved.
    const tints = Object.keys(L).filter((n) => /(^|-)tint(-|$)/.test(n) && L[n]!.startsWith("rgba"));
    const overSurface = tints.filter((n) => contrast(paper("color-ink-mute"), over(parse(L[n]!), P_SURFACE)) < 4.5);
    expect(tints.length).toBeGreaterThan(70);
    expect(overSurface).toEqual([]);
  });

  test("light — §19, answered: every ink clears the floor on a tint over the CANVAS", () => {
    // The first light drop stated its ratios against the SURFACE and had no
    // headroom on the CANVAS: ink-meta 4.59, amber 4.65, blue 4.62 bare, and
    // under 4.5 on every tint over it — 141 stories failed contrast on paper
    // for that one cause. The revised drop restates the palette against "the
    // worst real ground — a 12-16% accent tint over canvas": amber, blue, red
    // and ink-meta came down a notch, gold followed. This is that claim,
    // measured: every accent ink on every tint of its own hue, over the canvas.
    const failures: string[] = [];
    const tints = Object.keys(L).filter((n) => /(^|-)tint(-|$)/.test(n) && L[n]!.startsWith("rgba"));
    for (const tone of ["amber", "gold", "teal", "purple", "blue", "red"]) {
      for (const tint of tints.filter((n) => n.endsWith(`-${tone}`))) {
        const ratio = contrast(paper(`${tone}-ink`), over(parse(L[tint]!), P_CANVAS));
        if (ratio < 4.5) failures.push(`${tone}-ink over ${tint} on canvas = ${ratio}`);
      }
    }
    expect(tints.length).toBeGreaterThan(70);
    // ...and ink-meta, the kit's meta colour, over every tint on the canvas.
    // The design quotes 5.0 there; it is the one with the least room left.
    for (const tint of tints) {
      const ratio = contrast(paper("color-ink-mute"), over(parse(L[tint]!), P_CANVAS));
      if (ratio < 4.5) failures.push(`ink-mute over ${tint} on canvas = ${ratio}`);
    }
    expect(failures).toEqual([]);
    expect(contrast(paper("color-ink-mute"), P_CANVAS)).toBeGreaterThanOrEqual(5);
  });
});

// D55 / #1379: measure the new controls' actual token expressions.
for (const [theme, tokens] of [["dark", TOKENS], ["light", LIGHT_TOKENS]] as const) {
  function resolveColor(value: string): { rgb: Rgb; alpha: number } {
    const reference = /^var\(--bk-([\w-]+)\)$/.exec(value);
    if (reference) return resolveColor(tokens[reference[1]! as keyof typeof TOKENS]);
    const mix = /^color-mix\(in srgb, var\(--bk-([\w-]+)\) ([\d.]+)%, transparent\)$/.exec(value);
    if (mix) {
      const base = resolveColor(tokens[mix[1]! as keyof typeof TOKENS]);
      return { rgb: base.rgb, alpha: base.alpha * Number(mix[2]) / 100 };
    }
    return parse(value);
  }
  test(`${theme} — red-ink clears danger hover over surface`, () => {
    const ground = over(resolveColor(tokens["button-hover-bg-danger"]), parse(tokens["color-surface"]).rgb);
    expect(contrast(parse(tokens["red-ink"]).rgb, ground)).toBeGreaterThanOrEqual(4.5);
  });
  test(`${theme} — the overlay ground is the raised colour at 80%`, () => {
    const overlay = resolveColor(tokens["icon-button-overlay-bg"]);
    expect(overlay.rgb).toEqual(parse(tokens["color-raised"]).rgb);
    expect(overlay.alpha).toBeCloseTo(0.8, 5);
  });
  for (const backdrop of ["#ffffff", "#000000"]) {
    test(`${theme} — overlay ink-dim clears raised/80 over ${backdrop}`, () => {
      const ground = over(resolveColor(tokens["icon-button-overlay-bg"]), parse(backdrop).rgb);
      expect(contrast(parse(tokens["color-ink-dim"]).rgb, ground)).toBeGreaterThanOrEqual(4.5);
    });
  }
}
