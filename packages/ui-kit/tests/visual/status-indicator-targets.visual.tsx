/// <reference types="@vitest/browser-playwright" />
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, inject, test } from "vitest";
import { commands, page } from "vitest/browser";
import "../../src/styles.css";
import { DraftToolRow, SessionsHeader } from "../../stories/chrome/_status-indicator.js";

// #3281 under fine, coarse and mixed pointers (the rail projects, reduced
// motion): the indicator's 44px target beside Attach/Send in the draft row and
// beside Close in the Sessions header, at 320px and 200% text. Native taps at
// each target's inner edges must reach that control and nothing else.

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let outer: { width: number; height: number } | undefined;
const originalSize = document.documentElement.style.fontSize;
afterEach(async () => {
  await commands.rankTouch("touchCancel", []);
  if (root) flushSync(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
  document.documentElement.style.fontSize = originalSize;
  if (outer) { await commands.formViewport(outer.width, outer.height); outer = undefined; }
});

function premise() {
  const mode = inject("railPointer");
  expect(matchMedia("(any-pointer: coarse)").matches, "coarse media premise").toBe(mode !== "fine");
  expect(matchMedia("(any-pointer: fine)").matches, "fine media premise").toBe(mode !== "coarse");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
}
const rect = (el: Element) => el.getBoundingClientRect();
const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
const dialog = () => document.querySelector("dialog[open][data-status-details]");

for (const zoom of [1, 2]) test(`draft row and Sessions header targets: 44px, no overlap, native edge taps (${zoom * 100}% text)`, async () => {
  premise();
  outer = await commands.formViewport(320, 720);
  await page.viewport(320, 720);
  document.documentElement.style.fontSize = `${16 * zoom}px`;
  const hits = { attach: 0, send: 0, close: 0 };
  host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;padding:16px 8px;box-sizing:border-box;display:grid;gap:16px;align-content:start;background:var(--bk-color-canvas)";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<>
    <DraftToolRow draft="unknown" onAttach={() => hits.attach++} onSend={() => hits.send++} />
    <SessionsHeader onClose={() => hits.close++} />
  </>));
  await document.fonts.ready;

  const groups = [
    [host.querySelector("[data-draft-attach]")!, host.querySelector("[data-draft-row] .bk-status-indicator-btn")!, host.querySelector("[data-draft-send]")!],
    [host.querySelector("[data-sessions-header] .bk-status-indicator-btn")!, host.querySelector("[data-sessions-close]")!],
  ] as HTMLButtonElement[][];
  for (const group of groups) {
    for (const button of group) {
      const box = rect(button);
      const name = button.getAttribute("aria-label");
      expect(box.width, `44px width: ${name}`).toBe(44);
      expect(box.height, `44px height: ${name}`).toBe(44);
      expect(box.left >= 0 && box.right <= 320, `inside 320px: ${name}`).toBe(true);
      // 1px inside every edge (D: one hit-area utility, #3252). The indicator's
      // corners are its own as well; IconButton's rounded corners are not claimed.
      const midX = box.left + box.width / 2, midY = box.top + box.height / 2;
      const probes = [[box.left + 1, midY], [box.right - 1, midY], [midX, box.top + 1], [midX, box.bottom - 1]];
      if (button.classList.contains("bk-status-indicator-btn")) for (const x of [box.left + 1, box.right - 1]) for (const y of [box.top + 1, box.bottom - 1]) probes.push([x, y]);
      for (const [x, y] of probes) expect(document.elementFromPoint(x!, y!)?.closest("button"), `edge hit: ${name} at ${x},${y}`).toBe(button);
    }
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      expect(overlaps(rect(group[i]!), rect(group[j]!)), `${group[i]!.getAttribute("aria-label")} vs ${group[j]!.getAttribute("aria-label")}`).toBe(false);
    }
  }

  const tap = async (button: HTMLButtonElement, x: number) => {
    const box = rect(button);
    await commands.rankTouch("touchStart", [{ x, y: box.top + box.height / 2 }]);
    await commands.rankTouch("touchEnd", []);
  };
  const [attach, indicator, send] = groups[0]!;
  // The indicator's inner edges, right next to Attach and Send.
  await tap(indicator!, rect(indicator!).left + 2);
  await expect.poll(dialog, { message: "left-edge tap opens details" }).not.toBeNull();
  expect(hits).toEqual({ attach: 0, send: 0, close: 0 });
  await commands.rankTouch("touchCancel", []);
  (dialog() as HTMLDialogElement).querySelector<HTMLButtonElement>(".bk-overlay-close-slot button")!.click();
  await expect.poll(dialog).toBeNull();
  await tap(indicator!, rect(indicator!).right - 2);
  await expect.poll(dialog, { message: "right-edge tap opens details" }).not.toBeNull();
  (dialog() as HTMLDialogElement).querySelector<HTMLButtonElement>(".bk-overlay-close-slot button")!.click();
  await expect.poll(dialog).toBeNull();
  // Neighbours' edges facing the indicator reach the neighbours only.
  await tap(attach!, rect(attach!).right - 2);
  await tap(send!, rect(send!).left + 2);
  const [sessionsIndicator, close] = groups[1]!;
  await tap(close!, rect(close!).left + 2);
  expect(hits).toEqual({ attach: 1, send: 1, close: 1 });
  expect(dialog(), "neighbour taps do not open details").toBeNull();
  await tap(sessionsIndicator!, rect(sessionsIndicator!).right - 2);
  await expect.poll(dialog).not.toBeNull();
  expect(hits.close).toBe(1);
  (dialog() as HTMLDialogElement).querySelector<HTMLButtonElement>(".bk-overlay-close-slot button")!.click();
  await expect.poll(dialog).toBeNull();
});
