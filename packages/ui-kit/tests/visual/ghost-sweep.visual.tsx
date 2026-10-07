import { commands } from "vitest/browser";
import { afterEach, expect, test } from "vitest";
import * as stories from "../../stories/states/GhostSweep.stories.js";
import * as placeholder from "../../stories/states/Placeholder.stories.js";

interface Story { run: (context?: { globals?: Record<string, unknown> }) => Promise<void> }
const run = (story: unknown, theme = "dark") => (story as Story).run({ globals: { theme } });
const track = () => document.querySelector<HTMLElement>(".bk-ghost-track")!;
const rect = (e: Element) => e.getBoundingClientRect();
const freeze = (ms: number) => {
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
};
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// Independent cubic Bezier evaluation of CSS ease-in-out, not the animated transform.
function eased(t: number) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const u = (lo + hi) / 2;
    const x = 3 * (1 - u) ** 2 * u * .42 + 3 * (1 - u) * u ** 2 * .58 + u ** 3;
    if (x < t) lo = u; else hi = u;
  }
  const u = (lo + hi) / 2;
  return 3 * (1 - u) * u ** 2 + u ** 3;
}

afterEach(async () => { await commands.ghostMedia("no-preference", "screen"); });

for (const theme of ["dark", "light"]) {
  test(`${theme}: six owning frames, static glyphs, only transform/opacity animations, safe identical copies`, async () => {
    await run(stories.Gallery, theme);
    const tracks = [...document.querySelectorAll<HTMLElement>(".bk-ghost-track")];
    expect(tracks).toHaveLength(6);
    freeze(1300);
    for (const t of tracks) {
      expect(t.querySelectorAll(".bk-ghost-window")).toHaveLength(3);
      expect(t.hasAttribute("inert")).toBe(true);
      expect(t.getAttribute("aria-hidden")).toBe("true");
      expect(t.querySelector("button,input,select,textarea,a,img,iframe,[id],[tabindex],script")).toBeNull();
      const base = [...t.parentElement!.parentElement!.querySelectorAll<HTMLElement>(".bk-ghost")];
      expect(base.length).toBeGreaterThan(0);
      for (const copy of t.querySelectorAll(".bk-ghost-copy")) {
        const glyphs = [...copy.querySelectorAll<HTMLElement>(".bk-ghost-copy-glyph")];
        expect(glyphs.map((g) => g.textContent)).toEqual(base.map((g) => g.textContent));
        for (const [i, g] of glyphs.entries()) {
          for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(rect(g)[key] - rect(base[i]!)[key]), `${key} alignment`).toBeLessThanOrEqual(.5);
        }
      }
    }
    for (const g of document.querySelectorAll(".bk-ghost")) expect(getComputedStyle(g).animationName).toBe("none");
    for (const a of document.getAnimations()) {
      const target = (a.effect as KeyframeEffect).target as Element;
      if (!target.closest(".bk-ghost-track")) continue;
      for (const keyframe of (a.effect as KeyframeEffect).getKeyframes()) {
        expect(Object.keys(keyframe).filter((k) => !["offset", "computedOffset", "easing", "composite", "transform", "opacity"].includes(k))).toEqual([]);
      }
    }
  });
}

for (const width of [200, 800]) {
  test(`${width}px: broad edge ramps for short and long text, wrapping copies and V5 path`, async () => {
    await run(placeholder.Loading);
    const owner = track().parentElement!.parentElement!;
    owner.style.width = `${width}px`;
    await frame();
    // Both base and copies respond to the same frame width; the 5/120-char
    // fixture in Gallery exercises the text-length comparison separately.
    const t = track();
    const band = t.querySelector<HTMLElement>(".bk-ghost-band")!;
    const em = parseFloat(getComputedStyle(t).fontSize);
    const masks = [...t.querySelectorAll(".bk-ghost-window")].map((w) => getComputedStyle(w).maskImage);
    for (const mask of masks) expect(mask).toContain("96deg");
    expect(masks[0]).toContain("40%");
    expect(masks[2]).toContain("60%");
    expect(rect(band).width, "band spans the whole text block").toBeGreaterThanOrEqual(rect(t).width - .1);
    expect(rect(band).width).toBeGreaterThanOrEqual(9 * em - .1);
    const W = owner.clientWidth;
    const T = W + 1.2 * em;
    const B = rect(band).width;
    for (let tick = 0; tick < 26; tick++) {
      const ms = tick * 100;
      freeze(ms);
      const expected = rect(owner).left + owner.clientLeft - .6 * em - B + eased(ms / 2600) * (T + B);
      expect(Math.abs(rect(band).left - expected), `path at ${ms}ms`).toBeLessThanOrEqual(4);
      const base = owner.querySelector(".bk-ghost")!;
      const copy = t.querySelector(".bk-ghost-copy-glyph")!;
      expect(Math.abs(rect(copy).y - rect(base).y)).toBeLessThanOrEqual(.5);
    }
    freeze(0);
    expect(rect(band).right).toBeLessThanOrEqual(rect(owner).left);
    // An infinite animation is back at its start at the exact cycle boundary.
    freeze(2600);
    expect(rect(band).right).toBeLessThanOrEqual(rect(owner).left);
  });
}

test("20 rows + 6 cards, 6x CPU: steady paint and raster each <=5ms/s", async () => {
  await run(stories.Performance);
  expect(document.querySelectorAll(".bk-ghost-track")).toHaveLength(26);
  const measured = await commands.ghostTrace();
  expect(measured.paint, JSON.stringify(measured)).toBeLessThanOrEqual(5);
  expect(measured.raster, JSON.stringify(measured)).toBeLessThanOrEqual(5);
}, 30000);


async function pixels(base64: string) {
  const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const c = canvas.getContext("2d")!;
  c.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: c.getImageData(0, 0, img.width, img.height).data };
}

for (const width of [200, 800]) {
  test(`${width}px: rendered coloured glyph centre and blurred extent match the base`, async () => {
    // One font/blur role per capture: summing different type roles would
    // measure their relative luminance, rather than each glyph's alignment.
    for (const [index, story] of [stories.ShortLine, stories.LongLine].entries()) {
      await run(story);
      const owner = track().parentElement!.parentElement!;
      owner.style.width = `${width}px`;
      owner.dataset.ghostPixel = "target";
      await frame();
      freeze(1300);
      const t = owner.querySelector<HTMLElement>(".bk-ghost-track")!;
      const base = [...owner.querySelectorAll<HTMLElement>(".bk-ghost")];
      t.style.display = "none";
      const grey = await pixels(await commands.ghostPixels('[data-ghost-pixel="target"]'));
      for (const g of base) g.style.visibility = "hidden";
      const blank = await pixels(await commands.ghostPixels('[data-ghost-pixel="target"]'));
      t.style.display = "";
      for (const w of t.querySelectorAll<HTMLElement>(".bk-ghost-window")) {
        w.style.maskImage = "none";
        if (w.dataset.ghostHue !== "amber") w.style.display = "none";
      }
      const colour = await pixels(await commands.ghostPixels('[data-ghost-pixel="target"]'));
      expect([colour.width, colour.height]).toEqual([grey.width, grey.height]);
      function extent(image: typeof grey, threshold: number) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, mass = 0, centre = 0;
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
          const i = (y * image.width + x) * 4;
          const d = Math.max(...[0, 1, 2].map((c) => Math.abs(image.data[i + c]! - blank.data[i + c]!)));
          // Weight all non-background pixels for the vertical centre. The
          // extent uses explicit 8-bit visibility thresholds, so compression/
          // rounding noise cannot turn an imperceptible tail into a stray stripe.
          mass += d; centre += d * y;
          if (d < threshold) continue;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        expect(mass).toBeGreaterThan(0);
        expect(minX).toBeLessThan(Infinity);
        return { minX, minY, maxX, maxY, centre: centre / mass };
      }
      const g = extent(grey, 1), c = extent(colour, 8);
      expect(Math.abs(c.centre - g.centre) / (grey.width / rect(owner).width), `pixel centre, component ${index}`).toBeLessThanOrEqual(.5);
      expect(c.minX).toBeGreaterThanOrEqual(g.minX);
      expect(c.maxX).toBeLessThanOrEqual(g.maxX);
      expect(c.minY).toBeGreaterThanOrEqual(g.minY);
      expect(c.maxY).toBeLessThanOrEqual(g.maxY);
      delete owner.dataset.ghostPixel;
    }
  });
}


for (const width of [200, 800]) for (const [label, story] of [["5 characters", stories.ShortLine], ["120 characters", stories.LongLine]] as const) {
  test(`${width}px, ${label}: painted mask ramps spread over 40% of the full-block band`, async () => {
    await run(story);
    track().parentElement!.parentElement!.style.width = `${width}px`;
    await frame(); freeze(1300);
    const band = track().querySelector(".bk-ghost-band")!;
    for (const hue of ["amber", "blue"]) {
      const mask = getComputedStyle(track().querySelector(`[data-ghost-hue="${hue}"]`)!).maskImage;
      const bandWidth = rect(band).width;
      const img = await pixels(await commands.ghostMaskPixels(mask, bandWidth));
      const row = Array.from({ length: img.width }, (_, x) => img.data[(Math.floor(img.height / 2) * img.width + x) * 4]!);
      if (hue === "blue") row.reverse();
      const peak = Math.max(...row);
      expect(peak).toBeGreaterThan(240);
      // Fit the final straight ramp segment (.3 -> 1), rather than
      // rounding the peak to a screenshot pixel. Convert the painted
      // samples back to CSS px before measuring the end.
      const scale = img.width / bandWidth;
      const peakAt = row.findIndex((v, x) => x > 2 && v >= 250);
      const samples = row.slice(0, peakAt).map((v, x) => ({ x: (x + .5) / scale, y: v / 255 })).filter(({ x, y }) => x > 1 && y > .32 && y < .9);
      expect(samples.length).toBeGreaterThan(3);
      const mx = samples.reduce((n, v) => n + v.x, 0) / samples.length;
      const my = samples.reduce((n, v) => n + v.y, 0) / samples.length;
      const slope = samples.reduce((n, v) => n + (v.x - mx) * (v.y - my), 0) / samples.reduce((n, v) => n + (v.x - mx) ** 2, 0);
      const ramp = mx + (1 - my) / slope;
      expect(Math.abs(ramp - .40 * rect(band).width), `${hue} painted ramp at ${width}px ${JSON.stringify({ ramp, scale, image: img.width, css: bandWidth, peak, peakAt })}`).toBeLessThanOrEqual(1);
    }
  });
}

for (const width of [320, 800]) {
  test(`${width}px: stationary clipping frame prevents sweep scroll overflow`, async () => {
    await run(stories.Gallery);
    const gallery = track().parentElement!.parentElement!.parentElement!;
    gallery.style.width = `${width}px`;
    await frame(); freeze(0);
    const before = document.documentElement.scrollWidth;
    for (let ms = 0; ms < 2600; ms += 100) {
      freeze(ms);
      expect(document.documentElement.scrollWidth, `scroll width at ${ms}ms`).toBe(before);
    }
  });
}
