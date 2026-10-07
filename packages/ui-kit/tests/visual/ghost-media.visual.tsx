/**
 * Ghost text under the media that change it (#1116), in real Chromium with the
 * real media features emulated. Checks what WINS — the computed style — not
 * which declarations exist, so a more specific rule anywhere in the cascade
 * that brings the spectrum back under reduced motion fails here.
 */
import { commands } from "vitest/browser";
import { afterEach, expect, test } from "vitest";
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

test("reduced motion: the handoff is instant", async () => {
  await commands.ghostMedia("reduce", "screen");
  // The story's own play has already arrived once; load again, then arrive.
  await run(placeholder.Arrived);
  const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  button("Reload").click();
  await frames();
  expect(document.querySelector("[aria-busy]")).not.toBeNull();
  button("Arrive").click();
  await frames();
  expect(Number(getComputedStyle(document.querySelector(".bk-ghost-out")!).opacity)).toBe(0);
  expect(Number(getComputedStyle(document.querySelector(".bk-ghost-in")!).opacity)).toBe(1);
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
