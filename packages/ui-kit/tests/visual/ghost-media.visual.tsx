/**
 * Ghost text under the media that change it (#1116), in real Chromium with the
 * real media features emulated. Checks what WINS — the computed style — not
 * which declarations exist, so a more specific rule anywhere in the cascade
 * that brings the spectrum back under reduced motion fails here.
 */
import { commands } from "vitest/browser";
import { afterEach, expect, test, vi } from "vitest";
import { FIRST_FRAME_MS, HANDOFF_MS } from "../../src/internal/GhostText.js";
import * as placeholder from "../../stories/states/Placeholder.stories.js";

interface Story { run: (context?: { globals?: Record<string, unknown> }) => Promise<void> }
const run = (story: unknown, theme = "dark") => (story as Story).run({ globals: { theme } });
const ghosts = () => [...document.querySelectorAll<HTMLElement>(".bk-ghost")];

afterEach(async () => {
  await commands.ghostMedia("no-preference", "screen");
});

for (const [name, story] of [["animated", placeholder.Loading], ["still", placeholder.LoadingStill]] as const) {
  for (const theme of ["dark", "light"]) {
    test(`reduced motion, ${name}, ${theme}: plain blurred text, no spectrum, no sweep`, async () => {
      await commands.ghostMedia("reduce", "screen");
      await run(story, theme);
      expect(ghosts().length).toBeGreaterThan(0);
      for (const layer of document.querySelectorAll(".bk-ghost-track, .bk-ghost-track *")) {
        expect(getComputedStyle(layer).animationName).toBe("none");
      }
      expect(getComputedStyle(document.querySelector(".bk-ghost-track")!).display).toBe("none");
      for (const g of ghosts()) {
        const c = getComputedStyle(g);
        expect(c.animationName).toBe("none");
        expect(c.backgroundImage).toBe("none");
        // The glyphs are painted in the base colour itself, not through a gradient.
        expect(c.color).toBe(theme === "dark" ? "rgb(58, 61, 70)" : "rgb(200, 191, 172)");
        expect(c.filter).toMatch(/^blur\(/);
      }
    });
  }
}

test("without reduced motion the frame sweep runs through three masked windows", async () => {
  await run(placeholder.Loading);
  for (const g of ghosts()) {
    const c = getComputedStyle(g);
    expect(c.animationName).toBe("none");
    expect(c.backgroundImage).toBe("none");
    expect(c.color).toBe("rgb(58, 61, 70)");
  }
  expect(document.querySelectorAll(".bk-ghost-track")).toHaveLength(1);
  expect(getComputedStyle(document.querySelector(".bk-ghost-track")!).animationName).toBe("ghost");
  expect(document.querySelectorAll(".bk-ghost-window")).toHaveLength(3);
  for (const w of document.querySelectorAll(".bk-ghost-window")) {
    expect(getComputedStyle(w).maskImage).toContain("linear-gradient");
    expect(getComputedStyle(w).maskRepeat).toBe("no-repeat");
  }
});

/**
 * Reload and arrive Placeholder's `Arrived` story once more, recording every
 * timer delay registered from the arrival on (#3425). Real timers still run.
 */
async function arrive(check: () => void, before?: () => void) {
  // The story's own play has already arrived once; load again, then arrive.
  await run(placeholder.Arrived);
  const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  button("Reload").click();
  await frames();
  expect(document.querySelector("[aria-busy]")).not.toBeNull();
  before?.();
  const delays: number[] = [];
  const native = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: unknown[]) => {
    delays.push(Number(args[1] ?? 0));
    return Reflect.apply(native, globalThis, args);
  }) as typeof native);
  try {
    button("Arrive").click();
    await frames();
    expect(document.querySelector(".bk-ghost-out"), "the outgoing ghost stays until HANDOFF_MS").not.toBeNull();
    check();
    // Never waiting for an animation end that does not come: the ghost goes.
    await vi.waitFor(() => expect(document.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0), { timeout: FIRST_FRAME_MS - HANDOFF_MS, interval: 20 });
  } finally {
    timer.mockRestore();
  }
  // With no fade to wait for, the handoff ends on its 600ms timer, not on the
  // fallback for a document that renders no frames.
  expect(delays, "the handoff's 600ms timer").toContain(HANDOFF_MS);
  expect(delays, "no wait for a first frame").not.toContain(FIRST_FRAME_MS);
}

test("reduced motion: the handoff is instant, and ends after HANDOFF_MS", async () => {
  await commands.ghostMedia("reduce", "screen");
  await arrive(() => {
    expect(Number(getComputedStyle(document.querySelector(".bk-ghost-out")!).opacity)).toBe(0);
    expect(Number(getComputedStyle(document.querySelector(".bk-ghost-in")!).opacity)).toBe(1);
  });
});

test("animation: none: no fade runs, and the handoff still ends after HANDOFF_MS", async () => {
  const none = document.createElement("style");
  none.textContent = ".bk-ghost-in, .bk-ghost-out { animation: none !important; }";
  try {
    // After the story's own play, which checks the fades it normally has.
    await arrive(() => {
      expect(getComputedStyle(document.querySelector(".bk-ghost-out")!).animationName).toBe("none");
      expect(document.querySelector(".bk-ghost-out")!.getAnimations()).toHaveLength(0);
    }, () => document.head.append(none));
  } finally {
    none.remove();
  }
});

test("print: every ghost is hidden and keeps its box", async () => {
  await commands.ghostMedia("no-preference", "print");
  await run(placeholder.Loading);
  expect(ghosts().length).toBeGreaterThan(0);
  for (const g of ghosts()) {
    expect(getComputedStyle(g).visibility).toBe("hidden");
    expect(g.getBoundingClientRect().height).toBeGreaterThan(0);
  }
});
