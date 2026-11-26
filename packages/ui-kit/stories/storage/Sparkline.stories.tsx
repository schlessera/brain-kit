import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { appAddedGap, appAddedRising, appAddedUnknown } from "../../fixtures/storage-history.js";
import { Sparkline } from "../../src/storage/Sparkline.js";
import { desktop, frame, openAt, phone } from "./_history.js";

/**
 * `Sparkline` (#4543): "What this app added on this volume", a 120 × 24 line
 * that #4544 places in the stores breakdown. Gaps break it, a lone point is a
 * dot, and with nothing measured it draws no line and reads a mute `?`.
 */
const meta = preview.meta({
  title: "Storage/Sparkline",
  component: Sparkline,
  decorators: [frame],
  args: {
    points: appAddedRising,
    label: "App added 3.4 GB on Data volume in 7 days",
    valueLabel: "+3.4 GB · 7 d",
  },
});

type Ctx = { canvasElement: HTMLElement; globals: { viewport?: unknown }; parameters: { viewportWidth?: number } };

const img = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-part="sparkline"]')!;

async function open(ctx: Ctx) {
  await openAt(ctx.parameters.viewportWidth ?? 320, ctx.globals);
  const el = img(ctx.canvasElement);
  await expect(el.getAttribute("role")).toBe("img");
  await expect(el.querySelector("svg")!.getBoundingClientRect().width).toBe(120);
  await expect(el.querySelector("svg")!.getBoundingClientRect().height).toBe(24);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  return el;
}

/** Rising: one unbroken line ending in its value. */
export const Rising = meta.story({
  ...phone,
  play: async (ctx) => {
    const el = await open(ctx);
    await expect(el.querySelectorAll('[data-part="line"]')).toHaveLength(1);
    await expect(el.querySelector('[data-part="value"]')!.textContent).toBe("+3.4 GB · 7 d");
    await expect(el.getAttribute("aria-label")).toBe("App added 3.4 GB on Data volume in 7 days");
  },
});
export const RisingDesktop = Rising.extend({ ...desktop });

/** With a gap: the line breaks and the name counts it. */
export const WithGap = meta.story({
  ...phone,
  args: { points: appAddedGap },
  play: async (ctx) => {
    const el = await open(ctx);
    const lines = [...el.querySelectorAll('[data-part="line"]')];
    await expect(lines).toHaveLength(2);
    const [a, b] = lines.map((l) => l.getBoundingClientRect());
    await expect(a!.right).toBeLessThan(b!.left);
    await expect(el.getAttribute("aria-label")).toBe("App added 3.4 GB on Data volume in 7 days, 1 gap");
  },
});
export const WithGapDesktop = WithGap.extend({ ...desktop });

/** Unknown: no line at all and a mute `?`, never a zero. */
export const Unknown = meta.story({
  ...phone,
  args: { points: appAddedUnknown, label: "App added on Data volume", valueLabel: undefined },
  play: async (ctx) => {
    const el = await open(ctx);
    await expect(el.querySelectorAll('[data-part="line"], [data-part="dot"]')).toHaveLength(0);
    await expect(el.querySelector('[data-part="value"]')!.textContent).toBe("?");
    await expect(el.getAttribute("aria-label")).toBe("App added on Data volume, not measured");
  },
});
export const UnknownDesktop = Unknown.extend({ ...desktop });

/** All three without colour: the break and the `?` survive. */
export const Greyscale = meta.story({
  ...phone,
  render: (args) => (
    <div style={{ filter: "grayscale(1)", display: "flex", flexDirection: "column", gap: 12 }}>
      <Sparkline {...args} />
      <Sparkline {...args} points={appAddedGap} />
      <Sparkline points={appAddedUnknown} label="App added on Data volume" />
    </div>
  ),
  play: async ({ canvasElement, globals }) => {
    await openAt(320, globals);
    const all = [...canvasElement.querySelectorAll('[data-part="sparkline"]')];
    await expect(all.map((el) => el.querySelectorAll('[data-part="line"]').length)).toEqual([1, 2, 0]);
    await expect(all[2]!.textContent).toBe("?");
  },
});
