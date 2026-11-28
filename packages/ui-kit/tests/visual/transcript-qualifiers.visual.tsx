/// <reference types="@vitest/browser-playwright" />
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { TranscriptQualifiers } from "../../src/conversation/TranscriptQualifiers.js";

// The glyph trigger's hover hint in real Chromium (the `visual` project, fine
// pointer). Server-rendered markup is in `tests/transcript-qualifiers.test.tsx`.

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let outer: { width: number; height: number } | undefined;
afterEach(async () => {
  if (root) flushSync(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
  if (outer) { await commands.formViewport(outer.width - 100, outer.height - 120); outer = undefined; }
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function mount(node: ReactNode, width = 320, height = 720) {
  outer ??= await commands.formViewport(width, height);
  await commands.formViewport(width, height);
  await page.viewport(width, height);
  host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;padding:200px 16px 16px;box-sizing:border-box;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
  await document.fonts.ready;
}
const trigger = () => host!.querySelector<HTMLButtonElement>(".bk-transcript-qualifiers")!;
const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"].bk-transcript-tooltip');
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open][data-transcript-details]");

test("after details close under a resting pointer, the tooltip waits for the pointer to leave and return (#4727)", async () => {
  await mount(<><p>Odysseus asks for the raft list. <TranscriptQualifiers kind="recognized" source="Ithaca dictation" evidenceLabel="Technical evidence"><p>Recognized fragment</p></TranscriptQualifiers></p><button type="button" data-outside="">Ithaca</button></>);
  const control = trigger();
  await userEvent.hover(control);
  await expect.poll(tooltip).not.toBeNull();
  await userEvent.click(control);
  await expect.poll(dialog).not.toBeNull();
  expect(tooltip(), "opening details hides the tooltip").toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(dialog).toBeNull();
  expect(document.activeElement, "Escape returns focus to the trigger").toBe(control);
  // The pointer never left: move it inside the trigger so the browser sees it
  // arrive there again now that the modal is gone.
  await userEvent.hover(control, { position: { x: 6, y: 6 } });
  await pause(400);
  expect(tooltip(), "no tooltip after details close under the pointer").toBeNull();
  await userEvent.hover(host!.querySelector("[data-outside]")!);
  control.blur();
  await userEvent.hover(control);
  await expect.poll(tooltip, { message: "leaving and returning shows the tooltip again" }).not.toBeNull();
});

test("after details close by keyboard with the pointer elsewhere, the first hover shows the tooltip (#4935)", async () => {
  await mount(<><p>Odysseus asks for the raft list. <TranscriptQualifiers kind="recognized" source="Ithaca dictation" evidenceLabel="Technical evidence"><p>Recognized fragment</p></TranscriptQualifiers></p><button type="button" data-outside="">Ithaca</button></>);
  const control = trigger();
  await userEvent.hover(host!.querySelector("[data-outside]")!);
  control.focus();
  await expect.poll(tooltip).not.toBeNull();
  await userEvent.keyboard("{Enter}");
  await expect.poll(dialog).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.poll(dialog).toBeNull();
  expect(document.activeElement, "Escape returns focus to the trigger").toBe(control);
  await pause(400);
  expect(tooltip(), "focus coming back from details shows no tooltip").toBeNull();
  // Measured from the pointer's arrival, seen before React's handler starts the timer (#3829).
  let enteredAt: number | undefined;
  let shownAt: number | undefined;
  const arrive = (event: PointerEvent) => { if (enteredAt === undefined && control.contains(event.target as Node)) enteredAt = performance.now(); };
  document.addEventListener("pointerover", arrive, { capture: true });
  const shown = new MutationObserver(() => { if (shownAt === undefined && tooltip()) shownAt = performance.now(); });
  shown.observe(document.body, { subtree: true, childList: true, attributes: true });
  try {
    await userEvent.hover(control);
    await expect.poll(tooltip, { message: "the first hover after a close away from the pointer shows the tooltip" }).not.toBeNull();
  } finally { shown.disconnect(); document.removeEventListener("pointerover", arrive, { capture: true }); }
  expect(enteredAt, "the pointer's arrival was observed").toBeTypeOf("number");
  expect(shownAt! - enteredAt!, "hover waits for the 300ms delay").toBeGreaterThanOrEqual(300);
});
