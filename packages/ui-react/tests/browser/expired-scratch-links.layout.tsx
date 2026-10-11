/**
 * A link or image into scratch whose file has been cleared (#1657), drawn in
 * a real chat answer at phone and desktop width, in both themes. The server
 * is a stub that answers 404 for every scratch file, the same answer the real
 * files route gives (`scratch-links-runtime.test.ts` proves that end to end).
 * The image reaches its placeholder the real way: the browser fails to load
 * it, and the check that follows says it is gone.
 *
 * Before each baseline: the accessible names carry "expired", nothing inert
 * is a link or a picture, the label meets 4.5:1, and nothing overflows 320px.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainMarkdown } from "../../src/components/chat/brain-markdown.js";
import { contrast, parse } from "../../../ui-kit/tests/_contrast.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined;
let styles: HTMLStyleElement, viewport: { width: number; height: number };
let outer: { width: number; height: number } | undefined;

beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  root?.dispose();
  host?.remove();
  renderer = undefined;
  root = undefined;
  host = undefined;
  document.documentElement.dataset.theme = "dark";
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  outer = undefined;
});

const answer = [
  "Here is what I made for the crossing at Scylla:",
  "",
  "- [The raft overview](.brain/scratch/raft/overview.pdf), as a PDF.",
  "- The crew list in `.brain/scratch/raft/crew-2026-07-12.csv`.",
  "- The sailing notes stay in [Raft reference](notes/raft-reference.md).",
  "",
  "![Hull of the raft, seen from the stern](.brain/scratch/raft/hull.png)",
].join("\n");

for (const width of [320, 1280]) {
  for (const theme of ["dark", "light"]) {
    test(`${theme} ${width}: cleared scratch references read as expired`, async () => {
      outer = await commands.formViewport(width, 720);
      await page.viewport(width, 720);
      document.documentElement.dataset.theme = theme;
      root = createBrainUiRoot({
        storage: null,
        request: async (url, init) => {
          const path = new URL(url, location.origin).searchParams.get("path") ?? "";
          if (init?.method === "HEAD" && path.startsWith(".brain/scratch/")) return new Response(null, { status: 404 });
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        },
      });
      host = document.createElement("div");
      host.style.cssText = `width:${Math.min(width, 720)}px;padding:16px;box-sizing:border-box;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
      document.body.append(host);
      renderer = createRoot(host);
      flushSync(() => renderer!.render(<BrainUiProvider root={root}><BrainMarkdown content={answer} fileLinks /></BrainUiProvider>));

      const chat = page.elementLocator(host);
      await expect.element(chat.getByRole("img", { name: "Hull of the raft, seen from the stern, expired", exact: true })).toBeVisible();
      await expect.element(chat.getByRole("link", { name: "The raft overview expired", exact: true })).toBeVisible();
      await expect.element(chat.getByRole("link", { name: ".brain/scratch/raft/crew-2026-07-12.csv expired", exact: true })).toBeVisible();
      // The link outside scratch is untouched: still a link, never checked.
      const kept = [...host.querySelectorAll("a")];
      expect(kept.map((a) => a.getAttribute("href"))).toEqual(["#/files/notes/raft-reference.md"]);
      expect(host.querySelector("img")).toBeNull();

      for (const label of host.querySelectorAll<HTMLElement>(".brain-expired-label")) {
        const fg = parse(getComputedStyle(label).color), bg = parse(getComputedStyle(host).backgroundColor);
        expect(contrast(fg.rgb, bg.rgb), `${theme} expired label contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expect(host.scrollWidth, "nothing overflows the answer").toBeLessThanOrEqual(host.clientWidth);
      const placeholder = host.querySelector<HTMLElement>(".brain-expired-image")!;
      expect(placeholder.getBoundingClientRect().right).toBeLessThanOrEqual(host.getBoundingClientRect().right);

      await document.fonts.ready;
      await expect(chat).toMatchScreenshot(`expired-scratch-${theme}-${width}`);
    });
  }
}
