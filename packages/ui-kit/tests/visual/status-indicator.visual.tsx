/// <reference types="@vitest/browser-playwright" />
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import "../../src/styles.css";
import { StatusIndicator, type StatusIndicatorOperation, type StatusIndicatorProps } from "../../src/chrome/StatusIndicator.js";
import { DraftToolRow, SessionsHeader, deletionOperations } from "../../stories/chrome/_status-indicator.js";

// #3281 in real Chromium (the `visual` project, fine pointer). Touch-edge hit
// testing under fine, coarse and mixed pointers is in
// `status-indicator-targets.visual.tsx`, run by the rail projects.

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalTheme = document.documentElement.dataset.theme;
const originalSize = document.documentElement.style.fontSize;
let outer: { width: number; height: number } | undefined;
afterEach(async () => {
  if (root) flushSync(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
  document.documentElement.style.fontSize = originalSize;
  await commands.dictationMotion("no-preference");
  if (outer) { await commands.formViewport(outer.width - 100, outer.height - 120); outer = undefined; }
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function mount(node: ReactNode, { width = 320, height = 720, theme = "dark", zoom = 1, style = "" }: { width?: number; height?: number; theme?: "dark" | "light"; zoom?: number; style?: string } = {}) {
  outer ??= await commands.formViewport(width, height);
  await commands.formViewport(width, height);
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.fontSize = `${16 * zoom}px`;
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;padding:16px;box-sizing:border-box;background:var(--bk-color-canvas);color:var(--bk-color-ink);${style}`;
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
  await document.fonts.ready;
  return { render: (next: ReactNode) => flushSync(() => root!.render(next)) };
}
const trigger = () => host!.querySelector<HTMLButtonElement>(".bk-status-indicator-btn")!;
const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"].bk-status-tooltip');
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open][data-status-details]");
const byText = (scope: Element, text: string) => [...scope.querySelectorAll<HTMLElement>('[role="button"],button')].find(b => b.textContent === text)!;
const live = () => document.querySelector<HTMLElement>("[data-status-live]")!;
const op = (o: Partial<StatusIndicatorOperation> & Pick<StatusIndicatorOperation, "state">): StatusIndicatorOperation => ({ id: "raft-list", stateLabel: `Raft list ${o.state}`, ...o });
const props = (operations: StatusIndicatorOperation[], extra: Partial<StatusIndicatorProps> = {}): StatusIndicatorProps =>
  ({ label: "Raft list", title: "Raft list status", summary: "Saving Odysseus's raft list to the brain.", operations, ...extra });
async function closeWithEscape() { await userEvent.keyboard("{Escape}"); await expect.poll(dialog).toBeNull(); }

test("hover, focus, click, Enter, Space and tap expose the same summary; activation opens details at the heading", async () => {
  const outside = <button type="button" data-outside="">Ithaca</button>;
  await mount(<><StatusIndicator {...props([op({ state: "active" })])} />{outside}</>);
  const control = trigger();
  expect(control.getAttribute("aria-label")).toBe("Raft list: Raft list active. Details.");
  expect(control.hasAttribute("title"), "no native title tooltip").toBe(false);

  // Hover: nothing before 300ms, the summary after. The delay is measured from
  // the pointer's arrival, seen in the capture phase before React's handler
  // starts the timer, to the tooltip's insertion, so a slow runner only
  // lengthens it; a fixed sleep inside the window raced the timer under load (#3829).
  let enteredAt: number | undefined;
  let shownAt: number | undefined;
  const arrive = (event: PointerEvent) => { if (enteredAt === undefined && control.contains(event.target as Node)) enteredAt = performance.now(); };
  document.addEventListener("pointerover", arrive, { capture: true });
  const shown = new MutationObserver(() => { if (shownAt === undefined && tooltip()) shownAt = performance.now(); });
  shown.observe(document.body, { subtree: true, childList: true, attributes: true });
  try {
    await userEvent.hover(control);
    await expect.poll(() => tooltip()?.textContent).toBe("Saving Odysseus's raft list to the brain.");
  } finally { shown.disconnect(); document.removeEventListener("pointerover", arrive, { capture: true }); }
  expect(enteredAt, "the pointer's arrival was observed").toBeTypeOf("number");
  expect(shownAt! - enteredAt!, "hover waits for the 300ms delay").toBeGreaterThanOrEqual(300);
  expect(control.getAttribute("aria-describedby")).toBe(tooltip()!.id);
  await userEvent.unhover(control);
  await userEvent.hover(host!.querySelector("[data-outside]")!);
  await expect.poll(tooltip).toBeNull();

  // Keyboard focus shows the same summary.
  (host!.querySelector("[data-outside]") as HTMLElement).focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(control);
  await expect.poll(() => tooltip()?.textContent).toBe("Saving Odysseus's raft list to the brain.");

  for (const [how, activate] of [
    ["click", () => userEvent.click(control)],
    ["Enter", async () => { control.focus(); await userEvent.keyboard("{Enter}"); }],
    ["Space", async () => { control.focus(); await userEvent.keyboard(" "); }],
  ] as const) {
    await activate();
    await expect.poll(dialog, { message: `${how} opens persistent details` }).not.toBeNull();
    expect(tooltip(), `${how} hides the tooltip`).toBeNull();
    expect(control.getAttribute("aria-expanded")).toBe("true");
    const heading = dialog()!.querySelector("h2")!;
    expect(document.activeElement, `${how} focuses the details heading`).toBe(heading);
    expect(heading.textContent).toBe("Raft list status");
    expect(dialog()!.textContent).toContain("Saving Odysseus's raft list to the brain.");
    expect(dialog()!.textContent).toContain("Raft list active");
    await closeWithEscape();
    expect(document.activeElement, `${how}: Escape returns focus to the trigger`).toBe(control);
    await pause(400);
    expect(tooltip(), `${how}: returning focus does not reopen the tooltip`).toBeNull();
    control.blur();
  }

  // A native touch tap opens details without a hover tooltip.
  const box = control.getBoundingClientRect();
  await commands.rankTouch("touchStart", [{ x: box.left + box.width / 2, y: box.top + box.height / 2 }]);
  await commands.rankTouch("touchEnd", []);
  await expect.poll(dialog, { message: "tap opens persistent details" }).not.toBeNull();
  expect(tooltip()).toBeNull();
  await closeWithEscape();
  expect(document.activeElement).toBe(control);
});

test("Escape hides the tooltip without moving focus or opening details", async () => {
  await mount(<StatusIndicator {...props([op({ state: "queued" })])} />);
  trigger().focus();
  await expect.poll(tooltip).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(tooltip()).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(dialog()).toBeNull();
  await pause(400);
  expect(tooltip(), "Escape suppresses the pending tooltip while focus stays").toBeNull();
});

test("the hover tooltip is reachable and dismisses when the pointer leaves both", async () => {
  await mount(<StatusIndicator {...props([op({ state: "unknown" })], { summary: "The save reply was lost. The raft list may or may not be stored. Treat it as unsaved until the host acknowledges it." })} />, { style: "padding-top:200px" });
  await userEvent.hover(trigger());
  await expect.poll(tooltip).not.toBeNull();
  await userEvent.hover(tooltip()!);
  await pause(400);
  expect(tooltip(), "moving onto the tooltip keeps it open").not.toBeNull();
  await userEvent.hover(host!, { position: { x: 300, y: 700 } });
  await expect.poll(tooltip).toBeNull();
});

for (const zoom of [1, 2]) test(`the tooltip stays inside a 320px viewport from all four corners at ${zoom * 100}% text`, async () => {
  const summary = "Waiting for the raft sketch to upload before the draft is saved. Nothing is saved yet; leaving now keeps the at-risk guard.";
  for (const [corner, place] of [["top-left", "top:0;left:0"], ["top-right", "top:0;right:0"], ["bottom-left", "bottom:0;left:0"], ["bottom-right", "bottom:0;right:0"]] as const) {
    await mount(<span style={{ position: "fixed", ...Object.fromEntries(place.split(";").map(p => p.split(":"))) }}><StatusIndicator {...props([op({ state: "queued" })], { summary })} /></span>, { zoom });
    trigger().focus();
    await expect.poll(tooltip).not.toBeNull();
    await pause(50);
    const t = tooltip()!.getBoundingClientRect();
    expect(t.left, `${corner} left`).toBeGreaterThanOrEqual(16);
    expect(t.right, `${corner} right`).toBeLessThanOrEqual(320 - 16 + 0.5);
    expect(t.top, `${corner} top`).toBeGreaterThanOrEqual(8);
    expect(t.bottom, `${corner} bottom`).toBeLessThanOrEqual(720 - 8 + 0.5);
    const b = trigger().getBoundingClientRect();
    expect(t.bottom <= b.top || t.top >= b.bottom, `${corner}: the tooltip flips rather than covering its trigger`).toBe(true);
    flushSync(() => root!.unmount()); host!.remove(); root = undefined; host = undefined;
  }
});

test("Escape, the close button and the scrim each close details and return focus to the trigger", async () => {
  await mount(<StatusIndicator {...props([op({ state: "failed" })])} />);
  const control = trigger();
  await userEvent.click(control);
  await expect.poll(dialog).not.toBeNull();
  await closeWithEscape();
  expect(document.activeElement).toBe(control);

  await userEvent.click(control);
  await expect.poll(dialog).not.toBeNull();
  await userEvent.click(dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close raft list status"]')!);
  await expect.poll(dialog).toBeNull();
  expect(document.activeElement).toBe(control);

  await userEvent.click(control);
  await expect.poll(dialog).not.toBeNull();
  const surface = dialog()!.querySelector(".bk-overlay-surface")!.getBoundingClientRect();
  await userEvent.click(dialog()!.querySelector(".bk-overlay-scrim")!, { position: { x: 4, y: Math.max(4, surface.top - 8) } });
  await expect.poll(dialog).toBeNull();
  expect(document.activeElement).toBe(control);
});

test("when the trigger goes while details are open, focus falls back to returnFocus", async () => {
  const fallback = <button type="button" data-fallback="">Sessions</button>;
  const view = (operations: StatusIndicatorOperation[], shown = true) => <>{fallback}{shown && <StatusIndicator {...props(operations, { returnFocus: () => host!.querySelector<HTMLElement>("[data-fallback]") })} />}</>;
  const s = await mount(view([op({ state: "unknown" })]));
  await userEvent.click(trigger());
  await expect.poll(dialog).not.toBeNull();
  // The operation list empties: the control is replaced by its reserved slot.
  s.render(view([]));
  await expect.poll(dialog).toBeNull();
  expect(host!.querySelector(".bk-status-indicator-btn")).toBeNull();
  await expect.poll(() => document.activeElement).toBe(host!.querySelector("[data-fallback]"));

  // The whole indicator unmounts while open.
  s.render(view([op({ state: "unknown" })]));
  await userEvent.click(trigger());
  await expect.poll(dialog).not.toBeNull();
  s.render(view([op({ state: "unknown" })], false));
  await expect.poll(dialog).toBeNull();
  await expect.poll(() => document.activeElement).toBe(host!.querySelector("[data-fallback]"));
});

test("open details update in place without moving focus, and announce state changes once, never progress", async () => {
  const messages: string[] = [];
  let last = "";
  const observer = new MutationObserver(() => {
    const text = document.querySelector("[data-status-live]")?.textContent ?? "";
    if (text !== last) { last = text; if (text) messages.push(text); }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  try {
    const check = (id: string) => <button type="button" data-check={id}>Check now</button>;
    const s = await mount(<StatusIndicator {...props([op({ state: "active", facts: [{ key: "Sent", value: "0 of 40" }], actions: check("raft-list") })])} />);
    await userEvent.click(trigger());
    await expect.poll(dialog).not.toBeNull();
    const heading = dialog()!.querySelector("h2")!;
    expect(document.activeElement).toBe(heading);
    expect(dialog()!.querySelectorAll("[data-status-live]"), "the open modal holds the one live region").toHaveLength(1);
    expect(document.querySelectorAll("[data-status-live]")).toHaveLength(1);

    for (let n = 1; n <= 20; n++) {
      s.render(<StatusIndicator {...props([op({ state: "active", facts: [{ key: "Sent", value: `${n} of 40` }], actions: check("raft-list") })], { summary: `Sent ${n} of 40 entries.` })} />);
      await pause(10);
    }
    expect(dialog()!.textContent).toContain("20 of 40");
    expect(document.activeElement, "progress keeps heading focus").toBe(heading);
    await pause(1200);
    expect(messages, "20 progress updates announce nothing").toEqual([]);

    // The user is on an action; a state change must not take focus away.
    dialog()!.querySelector<HTMLButtonElement>("[data-check]")!.focus();
    s.render(<StatusIndicator {...props([op({ state: "unknown", stateLabel: "Couldn't confirm the raft list was saved", actions: check("raft-list") })], { summary: "The save reply was lost." })} />);
    expect(dialog()!.textContent).toContain("Couldn't confirm the raft list was saved");
    expect(dialog()!.querySelector('[data-state="unknown"]'), "details show the new state").not.toBeNull();
    expect(trigger().getAttribute("aria-label")).toBe("Raft list: Couldn't confirm the raft list was saved. Details.");
    expect((document.activeElement as HTMLElement).dataset.check, "action focus kept").toBe("raft-list");
    await expect.poll(() => messages.length, { timeout: 3000 }).toBe(1);
    expect(messages[0]).toBe("Raft list: Couldn't confirm the raft list was saved.");
    await pause(1200);
    expect(messages, "exactly one announcement").toHaveLength(1);

    // A second operation entering failure behind an equal lead still speaks.
    s.render(<StatusIndicator {...props([
      op({ state: "unknown", stateLabel: "Couldn't confirm the raft list was saved" }),
      op({ id: "crew-ledger", state: "unknown", stateLabel: "Couldn't confirm the crew ledger was saved" }),
    ])} />);
    await expect.poll(() => messages.length, { timeout: 3000 }).toBe(2);
    expect(messages[1]).toBe("Raft list: Couldn't confirm the crew ledger was saved; 2 operations.");
    await closeWithEscape();
    expect(document.querySelectorAll("[data-status-live]"), "closed: one live region beside the trigger").toHaveLength(1);
    expect(host!.querySelector("[data-status-live]")).not.toBeNull();
  } finally { observer.disconnect(); }
});

test("a quick change and change back inside the coalescing window announces nothing", async () => {
  const s = await mount(<StatusIndicator {...props([op({ state: "queued" })])} />);
  s.render(<StatusIndicator {...props([op({ state: "active" })])} />);
  await pause(100);
  s.render(<StatusIndicator {...props([op({ state: "queued" })])} />);
  await pause(1400);
  expect(live().textContent).toBe("");
});

for (const theme of ["dark", "light"] as const) test(`unknown and success are distinct in glyph, name and colour (${theme})`, async () => {
  await mount(<>
    <span data-case="unknown"><StatusIndicator {...props([op({ state: "unknown", stateLabel: "Couldn't confirm saved" })])} /></span>
    <span data-case="success"><StatusIndicator {...props([op({ state: "success", stateLabel: "Saved" })])} /></span>
    <span data-case="empty"><StatusIndicator {...props([])} /></span>
  </>, { theme });
  const at = (c: string) => host!.querySelector<HTMLElement>(`[data-case="${c}"]`)!;
  const glyph = (c: string) => at(c).querySelector("svg")?.getAttribute("class") ?? "";
  expect(glyph("unknown")).toContain("lucide-circle-dashed");
  expect(glyph("success")).toContain("lucide-circle-check");
  expect(glyph("unknown")).not.toContain("lucide-circle-check");
  expect(at("unknown").querySelector("button")!.getAttribute("aria-label")).toBe("Raft list: Couldn't confirm saved. Details.");
  expect(at("success").querySelector("button")!.getAttribute("aria-label")).toBe("Raft list: Saved. Details.");
  const ink = (c: string) => getComputedStyle(at(c).querySelector("button")!).color;
  expect(ink("unknown")).not.toBe(ink("success"));
  const expected = theme === "dark" ? { unknown: "rgb(234, 179, 84)", success: "rgb(91, 181, 162)" } : { unknown: "rgb(111, 84, 12)", success: "rgb(21, 89, 76)" };
  expect(ink("unknown"), "gold ink").toBe(expected.unknown);
  expect(ink("success"), "teal ink").toBe(expected.success);
  // No evidence never paints success.
  expect(at("empty").querySelector("svg")).toBeNull();
  expect(at("empty").querySelector("button")).toBeNull();
});

const opacitySamples = async (el: Element, n = 8) => {
  const values: number[] = [];
  for (let i = 0; i < n; i++) { values.push(Number(getComputedStyle(el).opacity)); await pause(130); }
  return values;
};
test("only active breathes; reduced motion keeps it static with the same glyph and name", async () => {
  await commands.dictationMotion("no-preference");
  const s = await mount(<StatusIndicator {...props([op({ state: "active" })])} />);
  const glyph = () => host!.querySelector(".bk-status-glyph")!;
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
  const moving = await opacitySamples(glyph());
  expect(new Set(moving).size, "active visibly breathes").toBeGreaterThan(1);
  const animation = glyph().getAnimations()[0]!;
  const started = animation.startTime;
  // Progress re-renders never restart the animation.
  for (let n = 0; n < 5; n++) s.render(<StatusIndicator {...props([op({ state: "active", facts: [{ key: "Sent", value: `${n}` }] })], { summary: `Sent ${n}` })} />);
  expect(glyph().getAnimations()[0]).toBe(animation);
  expect(glyph().getAnimations()[0]!.startTime).toBe(started);

  for (const state of ["queued", "success", "attention", "unknown", "failed", "refused", "idle"] as const) {
    s.render(<StatusIndicator {...props([op({ state })])} />);
    expect(glyph().getAnimations(), `${state} is static`).toEqual([]);
  }

  s.render(<StatusIndicator {...props([op({ state: "active" })])} />);
  const name = trigger().getAttribute("aria-label");
  const shape = glyph().querySelector("svg")!.getAttribute("class");
  await commands.dictationMotion("reduce");
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  const still = await opacitySamples(glyph());
  expect(new Set(still), "reduced motion: no visual change").toEqual(new Set([1]));
  expect(trigger().getAttribute("aria-label")).toBe(name);
  expect(glyph().querySelector("svg")!.getAttribute("class")).toBe(shape);
  expect(shape).toContain("lucide-loader-circle");
});

test("opening details makes no request and runs no consumer action; each action targets its own operation", async () => {
  const calls: string[] = [];
  const s = await mount(<SessionsHeader operations={deletionOperations()} onAction={a => calls.push(`${a.operation}:${a.action}`)} />);
  const control = trigger();
  expect(control.getAttribute("aria-label")).toBe("Chat deletions: Attachment cleanup failed; 2 operations. Details.");
  expect(host!.querySelector(".bk-status-count")!.textContent).toBe("2");
  expect(host!.querySelector("[data-status-indicator]")!.getAttribute("data-status-indicator"), "worst state leads").toBe("failed");
  await commands.startRequestLog();
  await userEvent.click(control);
  await expect.poll(dialog).not.toBeNull();
  const requests = (await commands.requestLog({ settle: true })).filter(url => !url.includes("request-log-boundary"));
  expect(requests, "opening details is not an operation").toEqual([]);
  expect(calls, "no action on open").toEqual([]);
  const items = [...dialog()!.querySelectorAll<HTMLElement>("[data-status-operation]")];
  expect(items.map(i => i.dataset.statusOperation)).toEqual(["deletion-7f3a", "deletion-91c2"]);
  expect(items.map(i => i.dataset.state), "each operation keeps its own state").toEqual(["unknown", "failed"]);
  expect(dialog()!.textContent).not.toContain("Raft");
  await userEvent.click(byText(items[1]!, "Retry removal"));
  await userEvent.click(byText(items[0]!, "Check now"));
  expect(calls).toEqual(["deletion-91c2:retry", "deletion-7f3a:check"]);

  // Reordered operations: identity follows the id, never the index.
  s.render(<SessionsHeader operations={deletionOperations().reverse()} onAction={a => calls.push(`${a.operation}:${a.action}`)} />);
  const reordered = [...dialog()!.querySelectorAll<HTMLElement>("[data-status-operation]")];
  expect(reordered.map(i => i.dataset.statusOperation)).toEqual(["deletion-91c2", "deletion-7f3a"]);
  await userEvent.click(byText(reordered[0]!, "Retry removal"));
  expect(calls.at(-1)).toBe("deletion-91c2:retry");
  await closeWithEscape();
});

test("details stay inside a 320px viewport at 200% text, with wrapping facts and reachable actions", async () => {
  await mount(<SessionsHeader operations={deletionOperations()} />, { zoom: 2 });
  await userEvent.click(trigger());
  await expect.poll(dialog).not.toBeNull();
  const surface = dialog()!.querySelector<HTMLElement>(".bk-overlay-surface")!;
  const box = surface.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(320.5);
  const close = dialog()!.querySelector<HTMLElement>(".bk-overlay-close-slot")!.getBoundingClientRect();
  const heading = dialog()!.querySelector("h2")!.getBoundingClientRect();
  expect(close.bottom <= heading.top || close.right <= heading.left || close.left >= heading.right, "close never covers the heading").toBe(true);
  const body = dialog()!.querySelector<HTMLElement>(".bk-overlay-body")!;
  expect(body.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(body.clientWidth + 1);
  for (const button of dialog()!.querySelectorAll<HTMLElement>('.bk-status-actions [role="button"]')) {
    button.scrollIntoView({ block: "nearest" });
    const b = button.getBoundingClientRect();
    expect(b.right).toBeLessThanOrEqual(320.5);
    expect(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[role="button"]')).toBe(button);
  }
  await closeWithEscape();
});

// Visual review captures at 320 and 1280px in both themes (not baselines).
for (const theme of ["dark", "light"] as const) for (const width of [320, 1280]) test(`review captures: ${width}px ${theme}`, async () => {
  const name = `${width}-${theme === "light" ? "paper" : "dark"}`;
  const wideStyle = width === 1280 ? "padding:48px 360px" : "";
  const s = await mount(<div style={{ display: "grid", gap: 24 }}>
    <DraftToolRow draft="saving" />
    <DraftToolRow draft="saved" />
    <DraftToolRow draft="unknown" />
    <SessionsHeader operations={deletionOperations()} />
  </div>, { width, height: 720, theme, style: wideStyle });
  await commands.dictationMotion("reduce");
  const triggers = () => [...host!.querySelectorAll<HTMLButtonElement>(".bk-status-indicator-btn")];
  await commands.statusCapture(`${name}-rows`);
  triggers()[2]!.focus();
  await expect.poll(tooltip).not.toBeNull();
  await pause(50);
  await commands.statusCapture(`${name}-focus-tooltip`);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(triggers()[2]!);
  await expect.poll(dialog).not.toBeNull();
  await pause(250);
  await commands.statusCapture(`${name}-draft-details`);
  await closeWithEscape();
  await userEvent.click(triggers()[3]!);
  await expect.poll(dialog).not.toBeNull();
  await pause(250);
  await commands.statusCapture(`${name}-deletion-details`);
  await closeWithEscape();
  s.render(<div style={{ fontSize: "200%" }}><DraftToolRow draft="unknown" /></div>);
  await commands.statusCapture(`${name}-large-text`);
});
