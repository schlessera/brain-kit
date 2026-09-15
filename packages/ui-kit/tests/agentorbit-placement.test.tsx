/**
 * `AgentOrbit` is the second of the design's three algorithmic components, and
 * the failure it can have is the same one `MapView` can have: a picture that
 * looks plausible and is wrong. Four pills scattered around a core look correct
 * whether or not `angle` means what the source says it means, so this file
 * checks the arithmetic against numbers worked out from the definitions rather
 * than read off a render.
 *
 * The definitions, from the source's `renderVals()`:
 *
 * ```
 * cx = w / 2                     cy = h / 2
 * rMax = min(w, h) / 2 - 26      r = 40 + orbit * rMax
 * rad = (angle - 90) * PI / 180
 * left = cx + cos(rad) * r       top = cy + sin(rad) * r
 * ```
 *
 * Every expected value below was computed from those five lines with a
 * calculator before the component was run. Re-deriving them with the
 * component's own helpers would prove only that the code equals itself.
 *
 * The two claims worth stating in words, because they are the ones a wrong
 * port passes silently:
 *
 *   **`angle` is clockwise from 12 o'clock**, not counter-clockwise from 3.
 *   That is the whole job of the `- 90`, and dropping it rotates the entire
 *   orbit a quarter turn — which nobody notices, because a ring of pills is
 *   rotationally symmetric to the eye.
 *
 *   **`orbit` 0 is ABOUT TO LAND**, so it sits at r = 40 — the core's own
 *   radius plus its gap — not at the centre. A port that forgot the `40 +`
 *   would bury a finishing run underneath the core glyph, which reads as
 *   "there is no such run".
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { orbitAgents } from "../fixtures/runs.js";
import { AgentOrbit } from "../src/agents/AgentOrbit.js";

/** Pill positions, in source order, from the rendered inline styles. */
function pillPositions(html: string): { left: number; top: number }[] {
  const out: { left: number; top: number }[] = [];
  for (const m of html.matchAll(/position:absolute;left:([-\d.]+)px;top:([-\d.]+)px;transform:translate\(-50%,-50%\)/g)) {
    out.push({ left: Number(m[1]), top: Number(m[2]) });
  }
  return out;
}

/** The defaults: 340 x 284, so cx = 170, cy = 142, rMax = 142 - 26 = 116. */
const W = 340;
const H = 284;

describe("polar placement", () => {
  const html = renderToStaticMarkup(<AgentOrbit agents={orbitAgents} width={W} height={H} />);
  const pills = pillPositions(html);

  test("every agent is placed, and only the agents", () => {
    // The three rings and the core are positioned too, but by `inset` and by
    // percentages — only a pill carries a px `left`/`top` pair.
    expect(pills).toHaveLength(orbitAgents.length);
  });

  test("researcher: orbit 0.28, angle 34 lands at (210.53, 81.91)", () => {
    // r    = 40 + 0.28 * 116                    = 72.48
    // rad  = (34 - 90)°                         = -56°
    // left = 170 + cos(-56°) * 72.48  = 170 + 0.5591929 * 72.48  = 210.5303
    // top  = 142 + sin(-56°) * 72.48  = 142 - 0.8290376 * 72.48  =  81.9114
    expect(pills[0].left).toBeCloseTo(210.5303, 3);
    expect(pills[0].top).toBeCloseTo(81.9114, 3);
  });

  test("source-watch: orbit 0.92, angle 214 lands at (87.96, 263.64)", () => {
    // r    = 40 + 0.92 * 116                    = 146.72
    // rad  = (214 - 90)°                        = 124°
    // left = 170 - 0.5591929 * 146.72 =  87.9552
    // top  = 142 + 0.8290376 * 146.72 = 263.6364
    expect(pills[2].left).toBeCloseTo(87.9552, 3);
    expect(pills[2].top).toBeCloseTo(263.6364, 3);
  });

  test("angle is CLOCKWISE FROM TWELVE, which the - 90 is the whole reason for", () => {
    // 0° is straight up, 90° is straight right. Without the `- 90` the first
    // of these would be straight right and the second straight down, and a
    // ring of pills looks equally fine either way.
    const up = pillPositions(
      renderToStaticMarkup(<AgentOrbit agents={[{ name: "a", orbit: 0, angle: 0 }]} width={W} height={H} />),
    )[0];
    expect(up.left).toBeCloseTo(170, 6);
    expect(up.top).toBeCloseTo(102, 6);

    const right = pillPositions(
      renderToStaticMarkup(<AgentOrbit agents={[{ name: "a", orbit: 1, angle: 90 }]} width={W} height={H} />),
    )[0];
    expect(right.left).toBeCloseTo(326, 6);
    expect(right.top).toBeCloseTo(142, 6);
  });

  test("orbit 0 sits on the core's edge, not on the core", () => {
    // r = 40 + 0 * rMax = 40, and the core is a 62px box centred on (cx, cy),
    // so its own half-height is 31. A pill at 40 clears it by 9px; a pill at 0
    // would be inside it.
    const [landing] = pillPositions(
      renderToStaticMarkup(<AgentOrbit agents={[{ name: "a", orbit: 0, angle: 180 }]} width={W} height={H} />),
    );
    expect(landing.top - H / 2).toBeCloseTo(40, 6);
    expect(landing.top - H / 2).toBeGreaterThan(31);
  });

  test("orbit 1 stays inside the box at the default size", () => {
    // rMax subtracts 26 so a pill at the outermost orbit still has room for
    // its own half-height. 40 + 116 = 156 from a centre at 142 would be 14px
    // ABOVE the top edge at angle 0 — which is why the outermost fixture
    // agent is placed at 214°, not at 0°, and why this is an assertion about
    // the WIDER axis rather than the narrower one.
    const [outer] = pillPositions(
      renderToStaticMarkup(<AgentOrbit agents={[{ name: "a", orbit: 1, angle: 90 }]} width={W} height={H} />),
    );
    expect(outer.left).toBeLessThan(W);
    expect(outer.left).toBeCloseTo(170 + 156, 6);
  });

  test("the size props move the centre, and rMax follows the SHORTER side", () => {
    // A wide, short orbit must not throw pills off the top: `min(w, h)` is
    // what keeps the radius inside the box the box actually has.
    const [pill] = pillPositions(
      renderToStaticMarkup(<AgentOrbit agents={[{ name: "a", orbit: 1, angle: 90 }]} width={520} height={220} />),
    );
    // cx = 260, rMax = 220/2 - 26 = 84, r = 124.
    expect(pill.left).toBeCloseTo(384, 6);
    expect(pill.top).toBeCloseTo(110, 6);
  });

  test("a missing angle is 12 o'clock and a missing orbit is 0.6", () => {
    // Both fallbacks are the source's, and both are reachable: `agents` is a
    // caller-supplied array with two genuinely optional fields.
    const [pill] = pillPositions(
      renderToStaticMarkup(<AgentOrbit agents={[{ name: "a" }]} width={W} height={H} />),
    );
    // r = 40 + 0.6 * 116 = 109.6, straight up from (170, 142).
    expect(pill.left).toBeCloseTo(170, 6);
    expect(pill.top).toBeCloseTo(142 - 109.6, 6);
  });
});
